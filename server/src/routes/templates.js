const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const { pool } = require("../db/pool");
const { createOwnedAttachment } = require("../services/attachmentOwnership");
const { getActiveCompanyId } = require("../services/companyContext");
const { hasScreenAction } = require("../auth/authorization");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function requireTemplatesAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (req.user.group_name === "SuperAdmin") return next();
  if (hasScreenAction(req, "templates", "can_view") || hasScreenAction(req, "templates", "can_edit")) return next();
  return res.status(403).json({ ok: false, error: "FORBIDDEN" });
}

function requireTemplatesEdit(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (req.user.group_name === "SuperAdmin") return next();
  if (hasScreenAction(req, "templates", "can_edit") || hasScreenAction(req, "templates", "can_create")) return next();
  return res.status(403).json({ ok: false, error: "FORBIDDEN" });
}

function safeFileSegment(v) {
  const s = String(v || "");
  const cleaned = s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned || "file";
}

function ensureTemplatesDir() {
  const d = path.resolve(__dirname, "..", "..", "storage", "templates");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function isPdfUpload(file) {
  if (!file) return false;
  const name = typeof file.originalname === "string" ? file.originalname : "";
  const mime = typeof file.mimetype === "string" ? file.mimetype : "";
  if (mime === "application/pdf") return true;
  if (name.toLowerCase().endsWith(".pdf")) return true;
  return false;
}

function resolveTemplateCompanyId(req, rawValue) {
  const explicit = Number(rawValue);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const active = getActiveCompanyId(req);
  return Number.isFinite(active) && active > 0 ? active : null;
}

async function getCompanyTemplateTextOverride(client, companyId, templateKey) {
  const cid = Number(companyId);
  if (!Number.isFinite(cid) || cid <= 0) return null;
  const { rows } = await client.query(
    `
      select template_body
      from company_template_overrides
      where company_id = $1
        and template_key = $2
        and is_active = true
        and template_body is not null
      order by id desc
      limit 1
    `,
    [cid, templateKey]
  );
  return typeof rows[0]?.template_body === "string" ? rows[0].template_body : null;
}

async function upsertCompanyTemplateTextOverride(client, { companyId, templateKey, templateBody }) {
  const cid = Number(companyId);
  if (!Number.isFinite(cid) || cid <= 0) return;
  const current = await client.query(
    `
      select id
      from company_template_overrides
      where company_id = $1
        and template_key = $2
      limit 1
    `,
    [cid, templateKey]
  );
  const existing = current.rows[0] || null;
  if (existing) {
    await client.query(
      `
        update company_template_overrides
        set template_id = null,
            template_body = $1,
            is_active = true
        where id = $2
      `,
      [templateBody, existing.id]
    );
    return;
  }
  await client.query(
    `
      insert into company_template_overrides (company_id, template_key, template_id, template_body, is_active)
      values ($1,$2,null,$3,true)
    `,
    [cid, templateKey, templateBody]
  );
}

async function upsertTemplateWithAttachment(client, { templateKey, templateType, file, uploadedBy, companyId = null, ownerType = "template", ownerId = null }) {
  if (!isPdfUpload(file)) {
    const err = new Error("INVALID_FILE_TYPE");
    err.status = 400;
    throw err;
  }

  const dir = ensureTemplatesDir();
  const ext = ".pdf";
  const base = `${safeFileSegment(templateKey)}_${Date.now()}`;
  const fileName = `${base}${ext}`;
  const absFilePath = path.join(dir, fileName);
  fs.writeFileSync(absFilePath, file.buffer);

  const attach = await createOwnedAttachment(client, {
    fileName: file.originalname || fileName,
    filePath: absFilePath,
    mimeType: "application/pdf",
    fileSizeBytes: file.size || file.buffer.length || 0,
    uploadedBy,
    companyId,
    ownerType,
    ownerId,
  });
  const attachmentId = Number(attach?.id);

  const cur = await client.query(
    `
      select id, version_no
      from document_templates
      where template_key = $1
      limit 1
    `,
    [templateKey]
  );
  const current = cur.rows[0] || null;

  if (current) {
    const up = await client.query(
      `
        update document_templates
        set template_type = $1,
            attachment_id = $2,
            version_no = version_no + 1,
            is_active = true,
            updated_at = now()
        where id = $3
        returning id, version_no
      `,
      [templateType, attachmentId, current.id]
    );
    return { templateId: Number(up.rows[0]?.id), attachmentId, versionNo: Number(up.rows[0]?.version_no) };
  }

  const ins = await client.query(
    `
      insert into document_templates (template_key, template_type, attachment_id, version_no, is_active, updated_at)
      values ($1,$2,$3,1,true,now())
      returning id, version_no
    `,
    [templateKey, templateType, attachmentId]
  );
  return { templateId: Number(ins.rows[0]?.id), attachmentId, versionNo: Number(ins.rows[0]?.version_no) };
}

router.use(requireAuth);

router.get("/admin-data", requireTemplatesAccess, async (_req, res, next) => {
  try {
    const [groupsRes, distRes, usersRes, companiesRes] = await Promise.all([
      pool.query(
        `
          select pg.id, pg.group_name, pc.category_name
          from product_groups pg
          left join product_categories pc on pc.id = pg.category_id
          where pg.is_active = true
          order by pc.category_name asc nulls last, pg.group_name asc
        `
      ),
      pool.query(
        `
          select id, company_name
          from distributors
          where is_active = true
          order by company_name asc
        `
      ),
      pool.query(
        `
          select id, email, full_name, designation, phone
          from erp_users
          where is_active = true
          order by coalesce(full_name, email) asc, email asc
        `
      ),
      pool.query(
        `
          select id, company_code, coalesce(display_name, legal_name) as display_name
          from companies
          where is_active = true
          order by company_code asc
        `
      ),
    ]);

    return res.json({
      ok: true,
      product_groups: groupsRes.rows,
      distributors: distRes.rows,
      users: usersRes.rows,
      companies: companiesRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/quote-terms", async (req, res, next) => {
  try {
    const companyId = resolveTemplateCompanyId(req, req.query?.company_id);
    const companyBody = companyId ? await getCompanyTemplateTextOverride(pool, companyId, "QUOTE_TERMS") : null;
    const r = await pool.query(
      `
        select template_key, template_type, template_body
        from document_templates
        where template_key = 'QUOTE_TERMS' and is_active = true
        order by version_no desc, id desc
        limit 1
      `
    );
    const row = r.rows[0] || null;
    return res.json({
      ok: true,
      template: row
        ? {
            template_key: row.template_key,
            template_type: row.template_type,
            template_body: companyBody ?? row.template_body ?? "",
            company_id: companyId,
            scope: companyBody !== null ? "company" : "global",
          }
        : null,
    });
  } catch (err) {
    return next(err);
  }
});

router.put("/quote-terms", requireTemplatesEdit, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const templateBody = typeof body.template_body === "string" ? body.template_body : "";
    const companyId = resolveTemplateCompanyId(req, body.company_id);

    await client.query("begin");

    if (companyId) {
      await upsertCompanyTemplateTextOverride(client, {
        companyId,
        templateKey: "QUOTE_TERMS",
        templateBody,
      });
      await client.query("commit");
      return res.json({ ok: true });
    }

    const cur = await client.query(
      `
        select id
        from document_templates
        where template_key = 'QUOTE_TERMS'
        limit 1
      `
    );
    const current = cur.rows[0] || null;

    if (current) {
      await client.query(
        `
          update document_templates
          set template_type = 'quote_terms_text',
              attachment_id = null,
              template_body = $1,
              version_no = version_no + 1,
              is_active = true,
              updated_at = now()
          where id = $2
        `,
        [templateBody, current.id]
      );
    } else {
      await client.query(
        `
          insert into document_templates (template_key, template_type, attachment_id, version_no, is_active, template_body, updated_at)
          values ('QUOTE_TERMS', 'quote_terms_text', null, 1, true, $1, now())
        `,
        [templateBody]
      );
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

router.get("/quote-cover-letter", async (req, res, next) => {
  try {
    const companyId = resolveTemplateCompanyId(req, req.query?.company_id);
    const companyBody = companyId ? await getCompanyTemplateTextOverride(pool, companyId, "QUOTE_COVER_LETTER") : null;
    const r = await pool.query(
      `
        select template_key, template_type, template_body
        from document_templates
        where template_key = 'QUOTE_COVER_LETTER' and is_active = true
        order by version_no desc, id desc
        limit 1
      `
    );
    const row = r.rows[0] || null;
    return res.json({
      ok: true,
      template: row
        ? {
            template_key: row.template_key,
            template_type: row.template_type,
            template_body: companyBody ?? row.template_body ?? "",
            company_id: companyId,
            scope: companyBody !== null ? "company" : "global",
          }
        : null,
    });
  } catch (err) {
    return next(err);
  }
});

router.put("/quote-cover-letter", requireTemplatesEdit, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const templateBody = typeof body.template_body === "string" ? body.template_body : "";
    const companyId = resolveTemplateCompanyId(req, body.company_id);

    await client.query("begin");

    if (companyId) {
      await upsertCompanyTemplateTextOverride(client, {
        companyId,
        templateKey: "QUOTE_COVER_LETTER",
        templateBody,
      });
      await client.query("commit");
      return res.json({ ok: true });
    }

    const cur = await client.query(
      `
        select id
        from document_templates
        where template_key = 'QUOTE_COVER_LETTER'
        limit 1
      `
    );
    const current = cur.rows[0] || null;

    if (current) {
      await client.query(
        `
          update document_templates
          set template_type = 'quote_cover_letter_text',
              attachment_id = null,
              template_body = $1,
              version_no = version_no + 1,
              is_active = true,
              updated_at = now()
          where id = $2
        `,
        [templateBody, current.id]
      );
    } else {
      await client.query(
        `
          insert into document_templates (template_key, template_type, attachment_id, version_no, is_active, template_body, updated_at)
          values ('QUOTE_COVER_LETTER', 'quote_cover_letter_text', null, 1, true, $1, now())
        `,
        [templateBody]
      );
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

router.put("/quote-signature-user/:userId", requireTemplatesEdit, async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
    const designation = typeof body.designation === "string" ? body.designation.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";

    const r = await pool.query(
      `
        update erp_users
        set
          full_name = nullif($1, ''),
          designation = nullif($2, ''),
          phone = nullif($3, ''),
          updated_at = now()
        where id = $4
        returning id, email, full_name, designation, phone
      `,
      [fullName, designation, phone, userId]
    );
    const row = r.rows[0] || null;
    if (!row) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, user: row });
  } catch (err) {
    return next(err);
  }
});

router.get("/product-group-scope/:productGroupId", requireTemplatesAccess, async (req, res, next) => {
  try {
    const productGroupId = Number(req.params.productGroupId);
    if (!Number.isFinite(productGroupId)) return res.status(400).json({ ok: false });
    const companyId = resolveTemplateCompanyId(req, req.query?.company_id);

    const r = await pool.query(
      `
        select
          gst.company_id,
          dt.id as template_id,
          dt.template_key,
          dt.template_type,
          dt.version_no,
          a.id as attachment_id,
          a.file_name
        from product_group_scope_templates gst
        join document_templates dt on dt.id = gst.template_id and dt.is_active = true
        join attachments a on a.id = dt.attachment_id
        where gst.product_group_id = $1
          and gst.is_active = true
          and (
            $2::int is null
            and gst.company_id is null
            or $2::int is not null
            and (gst.company_id = $2::int or gst.company_id is null)
          )
        order by (gst.company_id = $2::int) desc, gst.id desc
        limit 1
      `,
      [productGroupId, companyId]
    );

    const row = r.rows[0] || null;
    const scope = companyId ? (Number(row?.company_id) === Number(companyId) ? "company" : "global") : "global";
    return res.json({ ok: true, template: row ? { ...row, scope, requested_company_id: companyId } : null });
  } catch (err) {
    return next(err);
  }
});

router.get("/product-group-scope/:productGroupId/file", requireTemplatesAccess, async (req, res, next) => {
  try {
    const productGroupId = Number(req.params.productGroupId);
    if (!Number.isFinite(productGroupId)) return res.status(400).json({ ok: false });
    const companyId = resolveTemplateCompanyId(req, req.query?.company_id);

    const r = await pool.query(
      `
        select
          a.file_name,
          a.file_path,
          a.mime_type
        from product_group_scope_templates gst
        join document_templates dt on dt.id = gst.template_id and dt.is_active = true
        join attachments a on a.id = dt.attachment_id
        where gst.product_group_id = $1
          and gst.is_active = true
          and (
            $2::int is null
            and gst.company_id is null
            or $2::int is not null
            and (gst.company_id = $2::int or gst.company_id is null)
          )
        order by (gst.company_id = $2::int) desc, gst.id desc
        limit 1
      `,
      [productGroupId, companyId]
    );
    const row = r.rows[0] || null;
    const filePath = row?.file_path;
    const fileName = typeof row?.file_name === "string" ? row.file_name.trim() : "";
    const fallback = fileName ? path.join(ensureTemplatesDir(), path.basename(fileName)) : null;
    const resolvedPath = filePath && fs.existsSync(filePath) ? filePath : fallback && fs.existsSync(fallback) ? fallback : null;
    if (!resolvedPath) return res.status(404).json({ ok: false, error: filePath ? "FILE_MISSING_ON_SERVER" : "NOT_SET" });
    res.setHeader("Content-Type", row?.mime_type || "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${String(path.basename(fileName || "scope.pdf")).replaceAll('"', "")}"`
    );
    return res.sendFile(resolvedPath);
  } catch (err) {
    return next(err);
  }
});

router.post(
  "/product-group-scope/:productGroupId",
  requireTemplatesEdit,
  upload.single("file"),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const productGroupId = Number(req.params.productGroupId);
      if (!Number.isFinite(productGroupId)) return res.status(400).json({ ok: false });
      if (!req.file) return res.status(400).json({ ok: false, error: "NO_FILE" });
      const companyId = resolveTemplateCompanyId(req, req.body?.company_id);

      await client.query("begin");

      const templateKey = companyId ? `PG_SCOPE_${productGroupId}_COMPANY_${companyId}` : `PG_SCOPE_${productGroupId}`;
      const templateType = "product_group_scope_pdf";
      const t = await upsertTemplateWithAttachment(client, {
        templateKey,
        templateType,
        file: req.file,
        uploadedBy: req.user.id,
        companyId,
        ownerType: "template",
        ownerId: companyId || productGroupId,
      });

      const cur = await client.query(
        `
          select id
          from product_group_scope_templates
          where product_group_id = $1
            and company_id is not distinct from $2::int
          limit 1
        `,
        [productGroupId, companyId]
      );
      const existing = cur.rows[0] || null;

      if (existing) {
        await client.query(
          `
            update product_group_scope_templates
            set template_id = $1, is_active = true
            where product_group_id = $2
              and company_id is not distinct from $3::int
          `,
          [t.templateId, productGroupId, companyId]
        );
      } else {
        await client.query(
          `
            insert into product_group_scope_templates (product_group_id, company_id, template_id, is_active)
            values ($1,$2,$3,true)
          `,
          [productGroupId, companyId, t.templateId]
        );
      }

      await client.query("commit");
      return res.json({ ok: true });
    } catch (err) {
      await client.query("rollback");
      return next(err);
    } finally {
      client.release();
    }
  }
);

router.delete("/product-group-scope/:productGroupId", requireTemplatesEdit, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const productGroupId = Number(req.params.productGroupId);
    if (!Number.isFinite(productGroupId)) return res.status(400).json({ ok: false });
    const companyId = resolveTemplateCompanyId(req, req.query?.company_id);
    await client.query("begin");
    // Deactivate the same row GET shows (company file, else the global fallback), not only an exact company match.
    const effective = await client.query(
      `
        select gst.id, gst.company_id
        from product_group_scope_templates gst
        where gst.product_group_id = $1
          and gst.is_active = true
          and (
            $2::int is null
            and gst.company_id is null
            or $2::int is not null
            and (gst.company_id = $2::int or gst.company_id is null)
          )
        order by (gst.company_id = $2::int) desc, gst.id desc
        limit 1
        for update
      `,
      [productGroupId, companyId]
    );
    const target = effective.rows[0] || null;
    if (!target) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "SCOPE_PDF_NOT_SET" });
    }
    const upd = await client.query(
      `
        update product_group_scope_templates
        set is_active = false
        where product_group_id = $1
          and company_id is not distinct from $2::int
          and is_active = true
      `,
      [productGroupId, target.company_id]
    );
    if (!upd.rowCount) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "SCOPE_PDF_NOT_REMOVED" });
    }
    await client.query("commit");

    const remaining = await pool.query(
      `
        select
          gst.company_id,
          dt.id as template_id,
          dt.template_key,
          dt.template_type,
          dt.version_no,
          a.id as attachment_id,
          a.file_name
        from product_group_scope_templates gst
        join document_templates dt on dt.id = gst.template_id and dt.is_active = true
        join attachments a on a.id = dt.attachment_id
        where gst.product_group_id = $1
          and gst.is_active = true
          and (
            $2::int is null
            and gst.company_id is null
            or $2::int is not null
            and (gst.company_id = $2::int or gst.company_id is null)
          )
        order by (gst.company_id = $2::int) desc, gst.id desc
        limit 1
      `,
      [productGroupId, companyId]
    );
    const row = remaining.rows[0] || null;
    return res.json({
      ok: true,
      removed_scope: target.company_id == null ? "global" : "company",
      removed_rows: upd.rowCount,
      template: row
        ? { ...row, scope: row.company_id == null ? "global" : "company", requested_company_id: companyId }
        : null,
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/letterhead/global", requireTemplatesAccess, async (_req, res, next) => {
  try {
    const r = await pool.query(
      `
        select
          dt.id as template_id,
          dt.template_key,
          dt.template_type,
          dt.version_no,
          a.id as attachment_id,
          a.file_name
        from document_templates dt
        join attachments a on a.id = dt.attachment_id
        where dt.template_key = 'QUOTE_LETTERHEAD' and dt.is_active = true
        limit 1
      `
    );
    const row = r.rows[0] || null;
    return res.json({ ok: true, template: row });
  } catch (err) {
    return next(err);
  }
});

router.post("/letterhead/global", requireTemplatesEdit, upload.single("file"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "NO_FILE" });
    await client.query("begin");
    await upsertTemplateWithAttachment(client, {
      templateKey: "QUOTE_LETTERHEAD",
      templateType: "quote_letterhead_pdf",
      file: req.file,
      uploadedBy: req.user.id,
      ownerType: "template",
    });
    await client.query("commit");
    return res.json({ ok: true });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.delete("/letterhead/global", requireTemplatesEdit, async (_req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `
        update document_templates
        set is_active = false,
            attachment_id = null,
            updated_at = now()
        where template_key = 'QUOTE_LETTERHEAD'
      `
    );
    await client.query("commit");
    return res.json({ ok: true });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/letterhead/distributor/:distributorId", requireTemplatesAccess, async (req, res, next) => {
  try {
    const distributorId = Number(req.params.distributorId);
    if (!Number.isFinite(distributorId)) return res.status(400).json({ ok: false });

    const r = await pool.query(
      `
        select
          dt.id as template_id,
          dt.template_key,
          dt.template_type,
          dt.version_no,
          a.id as attachment_id,
          a.file_name
        from distributor_letterheads dl
        join document_templates dt on dt.id = dl.template_id and dt.is_active = true
        join attachments a on a.id = dt.attachment_id
        where dl.distributor_id = $1 and dl.is_active = true
        order by dl.id desc
        limit 1
      `,
      [distributorId]
    );
    const row = r.rows[0] || null;
    return res.json({ ok: true, template: row });
  } catch (err) {
    return next(err);
  }
});

router.post(
  "/letterhead/distributor/:distributorId",
  requireTemplatesEdit,
  upload.single("file"),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const distributorId = Number(req.params.distributorId);
      if (!Number.isFinite(distributorId)) return res.status(400).json({ ok: false });
      if (!req.file) return res.status(400).json({ ok: false, error: "NO_FILE" });

      await client.query("begin");

      const templateKey = `DISTRIBUTOR_${distributorId}_LETTERHEAD`;
      const templateType = "distributor_letterhead_pdf";
      const t = await upsertTemplateWithAttachment(client, {
        templateKey,
        templateType,
        file: req.file,
        uploadedBy: req.user.id,
        ownerType: "template",
        ownerId: distributorId,
      });

      const cur = await client.query(
        `
          select id
          from distributor_letterheads
          where distributor_id = $1
          limit 1
        `,
        [distributorId]
      );
      const existing = cur.rows[0] || null;

      if (existing) {
        await client.query(
          `
            update distributor_letterheads
            set template_id = $1, is_active = true
            where distributor_id = $2
          `,
          [t.templateId, distributorId]
        );
      } else {
        await client.query(
          `
            insert into distributor_letterheads (distributor_id, template_id, is_active)
            values ($1,$2,true)
          `,
          [distributorId, t.templateId]
        );
      }

      await client.query("commit");
      return res.json({ ok: true });
    } catch (err) {
      await client.query("rollback");
      return next(err);
    } finally {
      client.release();
    }
  }
);

router.delete("/letterhead/distributor/:distributorId", requireTemplatesEdit, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const distributorId = Number(req.params.distributorId);
    if (!Number.isFinite(distributorId)) return res.status(400).json({ ok: false });
    await client.query("begin");
    await client.query(
      `
        update distributor_letterheads
        set is_active = false
        where distributor_id = $1
      `,
      [distributorId]
    );
    await client.query("commit");
    return res.json({ ok: true });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/letterhead/company/:companyId", requireTemplatesAccess, async (req, res, next) => {
  try {
    const companyId = Number(req.params.companyId);
    if (!Number.isFinite(companyId)) return res.status(400).json({ ok: false });

    const r = await pool.query(
      `
        select
          dt.id as template_id,
          dt.template_key,
          dt.template_type,
          dt.version_no,
          a.id as attachment_id,
          a.file_name
        from company_template_overrides cto
        join document_templates dt on dt.id = cto.template_id and dt.is_active = true
        join attachments a on a.id = dt.attachment_id
        where cto.company_id = $1 and cto.template_key = 'QUOTE_LETTERHEAD' and cto.is_active = true
        order by cto.id desc
        limit 1
      `,
      [companyId]
    );
    const row = r.rows[0] || null;
    return res.json({ ok: true, template: row });
  } catch (err) {
    return next(err);
  }
});

router.post("/letterhead/company/:companyId", requireTemplatesEdit, upload.single("file"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = Number(req.params.companyId);
    if (!Number.isFinite(companyId)) return res.status(400).json({ ok: false });
    if (!req.file) return res.status(400).json({ ok: false, error: "NO_FILE" });

    await client.query("begin");

    const templateKey = `COMPANY_${companyId}_LETTERHEAD`;
    const templateType = "company_letterhead_pdf";
    const t = await upsertTemplateWithAttachment(client, {
      templateKey,
      templateType,
      file: req.file,
      uploadedBy: req.user.id,
    });

    const cur = await client.query(
      `
        select id
        from company_template_overrides
        where company_id = $1 and template_key = 'QUOTE_LETTERHEAD'
        limit 1
      `,
      [companyId]
    );
    const existing = cur.rows[0] || null;

    if (existing) {
      await client.query(
        `
          update company_template_overrides
          set template_id = $1, is_active = true
          where company_id = $2 and template_key = 'QUOTE_LETTERHEAD'
        `,
        [t.templateId, companyId]
      );
    } else {
      await client.query(
        `
          insert into company_template_overrides (company_id, template_key, template_id, is_active)
          values ($1,'QUOTE_LETTERHEAD',$2,true)
        `,
        [companyId, t.templateId]
      );
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

router.delete("/letterhead/company/:companyId", requireTemplatesEdit, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = Number(req.params.companyId);
    if (!Number.isFinite(companyId)) return res.status(400).json({ ok: false });
    await client.query("begin");
    await client.query(
      `
        update company_template_overrides
        set is_active = false
        where company_id = $1 and template_key = 'QUOTE_LETTERHEAD'
      `,
      [companyId]
    );
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
