const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const { pool } = require("../db/pool");
const { hasScreenAction, requireScreenAction } = require("../auth/authorization");
const { createOwnedAttachment } = require("../services/attachmentOwnership");
const { getActiveCompanyId } = require("../services/companyContext");

const router = express.Router();

const NOTE_TYPES = new Set(["blocked", "confusing", "suggestion"]);
const NOTE_STATUSES = new Set(["open", "triaged", "done", "wont_fix"]);
const MAX_SCREENSHOT_BYTES = 1.5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SCREENSHOT_BYTES },
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function cleanText(value, max = 2000) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.slice(0, max);
}

function ensurePilotScreenshotDir() {
  const dir = path.resolve(__dirname, "..", "..", "storage", "pilot_feedback", "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isScreenshotImage(file) {
  if (!file) return false;
  const name = typeof file.originalname === "string" ? file.originalname.toLowerCase() : "";
  const mime = typeof file.mimetype === "string" ? file.mimetype.toLowerCase() : "";
  if (mime.startsWith("image/")) return true;
  if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".webp")) return true;
  if (name.endsWith(".heic") || name.endsWith(".heif") || mime.includes("heic") || mime.includes("heif")) return true;
  return false;
}

function parseOptionalUpload(req, res, next) {
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.includes("multipart/form-data")) return next();
  return upload.single("screenshot")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ ok: false, error: "SCREENSHOT_TOO_LARGE" });
      }
      return res.status(400).json({ ok: false, error: "UPLOAD_FAILED", detail: String(err.message || err) });
    }
    return next();
  });
}

router.use(requireAuth);

router.post("/", parseOptionalUpload, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const noteType = cleanText(body.note_type, 32).toLowerCase();
    const deskPage = cleanText(body.desk_page, 80);
    const deskLabel = cleanText(body.desk_label, 160) || null;
    const companyCode = cleanText(body.company_code, 32) || null;
    const referenceNo = cleanText(body.reference_no, 120) || null;
    const noteBody = cleanText(body.note_body, 4000);
    const companyId = getActiveCompanyId(req);
    const userId = asInt(req.user?.id);
    const file = req.file || null;

    if (!NOTE_TYPES.has(noteType)) return res.status(400).json({ ok: false, error: "INVALID_NOTE_TYPE" });
    if (!deskPage) return res.status(400).json({ ok: false, error: "DESK_REQUIRED" });
    if (!noteBody || noteBody.length < 3) return res.status(400).json({ ok: false, error: "NOTE_REQUIRED" });
    if (!userId) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

    if (file) {
      if (!isScreenshotImage(file)) return res.status(400).json({ ok: false, error: "INVALID_SCREENSHOT" });
      if ((file.size || file.buffer?.length || 0) > MAX_SCREENSHOT_BYTES) {
        return res.status(400).json({ ok: false, error: "SCREENSHOT_TOO_LARGE" });
      }
    }

    await client.query("begin");

    let screenshotAttachmentId = null;
    if (file) {
      const dir = ensurePilotScreenshotDir();
      const storedFileName = `pilot_note_${userId}_${Date.now()}.jpg`;
      const absFilePath = path.join(dir, storedFileName);
      fs.writeFileSync(absFilePath, file.buffer);

      const attach = await createOwnedAttachment(client, {
        fileName: file.originalname || storedFileName,
        filePath: absFilePath,
        mimeType: file.mimetype || "image/jpeg",
        fileSizeBytes: file.size || file.buffer.length || 0,
        uploadedBy: userId,
        companyId,
        ownerType: "pilot_screenshot",
        ownerId: null,
        visibilityScope: companyId ? "company" : "global",
      });
      if (!attach?.id) {
        await client.query("rollback");
        return res.status(500).json({ ok: false, error: "ATTACHMENT_FAILED" });
      }
      screenshotAttachmentId = attach.id;
    }

    const r = await client.query(
      `
        insert into pilot_feedback_notes (
          company_id,
          created_by,
          note_type,
          desk_page,
          desk_label,
          company_code,
          reference_no,
          note_body,
          screenshot_attachment_id
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        returning id, created_at, status, screenshot_attachment_id
      `,
      [companyId, userId, noteType, deskPage, deskLabel, companyCode, referenceNo, noteBody, screenshotAttachmentId]
    );

    if (screenshotAttachmentId && r.rows[0]?.id) {
      await client.query(`update attachments set owner_id = $2 where id = $1`, [screenshotAttachmentId, r.rows[0].id]);
    }

    await client.query("commit");
    return res.status(201).json({
      ok: true,
      note: r.rows[0] || null,
    });
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      /* ignore */
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/", requireScreenAction("pilot_feedback", "can_view"), async (req, res, next) => {
  try {
    const status = cleanText(req.query.status, 32).toLowerCase();
    const noteType = cleanText(req.query.note_type, 32).toLowerCase();
    const deskPage = cleanText(req.query.desk_page, 80);
    const q = cleanText(req.query.q, 120).toLowerCase();
    const limit = Math.min(Math.max(asInt(req.query.limit) || 100, 1), 300);

    const clauses = [];
    const params = [];

    if (NOTE_STATUSES.has(status)) {
      params.push(status);
      clauses.push(`n.status = $${params.length}`);
    }
    if (NOTE_TYPES.has(noteType)) {
      params.push(noteType);
      clauses.push(`n.note_type = $${params.length}`);
    }
    if (deskPage) {
      params.push(deskPage);
      clauses.push(`n.desk_page = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      clauses.push(
        `(
          lower(coalesce(n.note_body, '')) like $${params.length}
          or lower(coalesce(n.reference_no, '')) like $${params.length}
          or lower(coalesce(u.full_name, '')) like $${params.length}
          or lower(coalesce(u.email, '')) like $${params.length}
          or lower(coalesce(n.desk_label, '')) like $${params.length}
          or lower(coalesce(n.desk_page, '')) like $${params.length}
        )`
      );
    }

    params.push(limit);
    const whereSql = clauses.length ? `where ${clauses.join(" and ")}` : "";

    const r = await pool.query(
      `
        select
          n.id,
          n.company_id,
          n.created_by,
          n.note_type,
          n.desk_page,
          n.desk_label,
          n.company_code,
          n.reference_no,
          n.note_body,
          n.status,
          n.triage_note,
          n.triaged_by,
          n.triaged_at,
          n.created_at,
          n.updated_at,
          n.screenshot_attachment_id,
          u.full_name as created_by_name,
          u.email as created_by_email,
          c.company_code as company_code_resolved,
          c.display_name as company_name,
          t.full_name as triaged_by_name
        from pilot_feedback_notes n
        join erp_users u on u.id = n.created_by
        left join companies c on c.id = n.company_id
        left join erp_users t on t.id = n.triaged_by
        ${whereSql}
        order by
          case n.status when 'open' then 0 when 'triaged' then 1 else 2 end,
          case n.note_type when 'blocked' then 0 when 'confusing' then 1 else 2 end,
          n.created_at desc
        limit $${params.length}
      `,
      params
    );

    return res.json({
      ok: true,
      notes: r.rows.map((row) => ({
        ...row,
        has_screenshot: Boolean(row.screenshot_attachment_id),
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/summary", requireScreenAction("pilot_feedback", "can_view"), async (_req, res, next) => {
  try {
    const r = await pool.query(
      `
        select
          count(*)::int as total,
          count(*) filter (where status = 'open')::int as open_count,
          count(*) filter (where status = 'triaged')::int as triaged_count,
          count(*) filter (where status = 'done')::int as done_count,
          count(*) filter (where note_type = 'blocked' and status in ('open', 'triaged'))::int as blocked_open,
          count(*) filter (where note_type = 'confusing' and status in ('open', 'triaged'))::int as confusing_open,
          count(*) filter (where note_type = 'suggestion' and status in ('open', 'triaged'))::int as suggestion_open
        from pilot_feedback_notes
      `
    );
    return res.json({ ok: true, summary: r.rows[0] || null });
  } catch (err) {
    return next(err);
  }
});

router.post("/run-triage", requireScreenAction("pilot_feedback", "can_edit"), async (req, res, next) => {
  try {
    const webhookUrl = String(process.env.CURSOR_PILOT_TRIAGE_WEBHOOK_URL || "").trim();
    const webhookToken = String(process.env.CURSOR_PILOT_TRIAGE_WEBHOOK_TOKEN || "").trim();
    if (!webhookUrl || !webhookToken) {
      return res.status(503).json({ ok: false, error: "TRIAGE_WEBHOOK_NOT_CONFIGURED" });
    }

    const { rows } = await pool.query(
      `
        select
          n.id,
          n.company_id,
          n.note_type,
          n.desk_page,
          n.desk_label,
          n.company_code,
          n.reference_no,
          n.note_body,
          n.status,
          n.triage_note,
          n.created_at,
          n.screenshot_attachment_id,
          u.full_name as created_by_name,
          u.email as created_by_email,
          c.company_code as company_code_resolved,
          c.display_name as company_name
        from pilot_feedback_notes n
        join erp_users u on u.id = n.created_by
        left join companies c on c.id = n.company_id
        where n.status = 'open'
        order by
          case n.note_type when 'blocked' then 0 when 'confusing' then 1 else 2 end,
          n.created_at asc
        limit 100
      `
    );

    if (!rows.length) {
      return res.status(400).json({ ok: false, error: "NO_OPEN_NOTES" });
    }

    const appBase = String(process.env.APP_BASE_URL || "https://josh.absstem.com").replace(/\/$/, "");
    const notes = rows.map((row) => ({
      id: row.id,
      note_type: row.note_type,
      desk_page: row.desk_page,
      desk_label: row.desk_label,
      company_code: row.company_code || row.company_code_resolved || null,
      company_name: row.company_name || null,
      reference_no: row.reference_no,
      note_body: row.note_body,
      status: row.status,
      triage_note: row.triage_note,
      created_at: row.created_at,
      created_by_name: row.created_by_name,
      created_by_email: row.created_by_email,
      has_screenshot: Boolean(row.screenshot_attachment_id),
      screenshot_url: row.screenshot_attachment_id ? `${appBase}/hr/pilot-feedback/${row.id}/screenshot` : null,
    }));

    const authValue = webhookToken.toLowerCase().startsWith("bearer ") ? webhookToken : `Bearer ${webhookToken}`;
    const payload = {
      source: "josh-pilot-notes",
      triggered_by: {
        id: req.user?.id || null,
        full_name: req.user?.full_name || null,
        email: req.user?.email || null,
      },
      triggered_at: new Date().toISOString(),
      app_base_url: appBase,
      open_note_count: notes.length,
      notes,
      instruction:
        "Propose-only triage. Do not edit code, commit, or open a PR unless SuperAdmin later asks to implement an approved item.",
    };

    const upstream = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        Authorization: authValue,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const upstreamText = await upstream.text().catch(() => "");
    let upstreamJson = null;
    try {
      upstreamJson = upstreamText ? JSON.parse(upstreamText) : null;
    } catch {
      upstreamJson = null;
    }

    if (!upstream.ok) {
      process.stderr.write(`[pilot-triage-webhook] ${upstream.status} ${upstreamText.slice(0, 500)}\n`);
      return res.status(502).json({
        ok: false,
        error: "TRIAGE_WEBHOOK_FAILED",
        status: upstream.status,
        detail: upstreamJson?.message || upstreamText.slice(0, 300) || null,
      });
    }

    return res.json({
      ok: true,
      note_count: notes.length,
      note_ids: notes.map((n) => n.id),
      webhook_response: upstreamJson,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/screenshot", async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const userId = asInt(req.user?.id);
    const isAdmin = hasScreenAction(req, "pilot_feedback", "can_view") || req.user?.group_name === "SuperAdmin";

    const { rows } = await pool.query(
      `
        select
          n.id,
          n.created_by,
          a.file_path,
          a.mime_type,
          a.file_name
        from pilot_feedback_notes n
        join attachments a on a.id = n.screenshot_attachment_id
        where n.id = $1
          and n.screenshot_attachment_id is not null
        limit 1
      `,
      [id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ ok: false, error: "SCREENSHOT_NOT_FOUND" });
    if (!isAdmin && Number(row.created_by) !== userId) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!row.file_path || !fs.existsSync(row.file_path)) {
      return res.status(404).json({ ok: false, error: "FILE_MISSING" });
    }

    res.setHeader("Content-Type", row.mime_type || "image/jpeg");
    res.setHeader("Content-Disposition", `inline; filename="${String(row.file_name || "screenshot.jpg").replace(/"/g, "")}"`);
    return fs.createReadStream(row.file_path).pipe(res);
  } catch (err) {
    return next(err);
  }
});

router.patch("/:id", requireScreenAction("pilot_feedback", "can_edit"), async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const status = cleanText(body.status, 32).toLowerCase();
    const triageNote = body.triage_note === undefined ? undefined : cleanText(body.triage_note, 2000) || null;
    const userId = asInt(req.user?.id);

    if (status && !NOTE_STATUSES.has(status)) {
      return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    }
    if (!status && triageNote === undefined) {
      return res.status(400).json({ ok: false, error: "NO_CHANGES" });
    }

    const sets = ["updated_at = now()"];
    const params = [];

    if (status) {
      params.push(status);
      sets.push(`status = $${params.length}`);
      params.push(userId);
      sets.push(`triaged_by = $${params.length}`);
      sets.push("triaged_at = now()");
    }
    if (triageNote !== undefined) {
      params.push(triageNote);
      sets.push(`triage_note = $${params.length}`);
    }

    params.push(id);
    const r = await pool.query(
      `
        update pilot_feedback_notes
        set ${sets.join(", ")}
        where id = $${params.length}
        returning id, status, triage_note, triaged_by, triaged_at, updated_at
      `,
      params
    );

    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, note: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
