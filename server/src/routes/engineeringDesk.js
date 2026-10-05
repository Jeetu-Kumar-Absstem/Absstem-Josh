const express = require("express");
const fs = require("fs");
const multer = require("multer");
const path = require("path");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const { notifyEngineeringAssigned, notifyEngineeringSalesUpdate } = require("../services/notifications");
const { createOwnedAttachment } = require("../services/attachmentOwnership");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const REQUEST_TYPES = new Set(["client_datasheet", "npd", "drawing", "technical_data", "bom_release"]);
const REQUEST_STATUSES = new Set(["new", "in_review", "waiting_input", "ready", "closed", "cancelled"]);
const REQUEST_PRIORITIES = new Set(["critical", "high", "normal", "low"]);
const SOURCE_DESKS = new Set(["sales", "engineering", "manufacturing", "quality", "service", "purchase", "admin", "other"]);

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function cleanText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function cleanDate(value) {
  const text = cleanText(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeLimit(value, fallback = 80, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

function normalizeRequestType(value) {
  const raw = String(value || "").trim().toLowerCase();
  return REQUEST_TYPES.has(raw) ? raw : "client_datasheet";
}

function normalizeRequestStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  return REQUEST_STATUSES.has(raw) ? raw : "new";
}

function normalizeRequestPriority(value) {
  const raw = String(value || "").trim().toLowerCase();
  return REQUEST_PRIORITIES.has(raw) ? raw : "normal";
}

function normalizeSourceDesk(value) {
  const raw = String(value || "").trim().toLowerCase();
  return SOURCE_DESKS.has(raw) ? raw : "other";
}

function normalizeBucket(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw || "all";
}

function isOpenStatus(status) {
  return !["closed", "cancelled"].includes(String(status || "").trim().toLowerCase());
}

function safeFileSegment(s) {
  return String(s || "")
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}

function mapRequestRow(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    quote_header_id: row.quote_header_id ? Number(row.quote_header_id) : null,
    requester_user_id: row.requester_user_id ? Number(row.requester_user_id) : null,
    assigned_to_user_id: row.assigned_to_user_id ? Number(row.assigned_to_user_id) : null,
    created_by: row.created_by ? Number(row.created_by) : null,
    updated_by: row.updated_by ? Number(row.updated_by) : null,
    is_open: isOpenStatus(row.request_status),
    overdue: Boolean(row.requested_due_date && isOpenStatus(row.request_status) && String(row.requested_due_date) < new Date().toISOString().slice(0, 10)),
  };
}

async function loadRequestAttachments(client, requestIds) {
  const ids = (Array.isArray(requestIds) ? requestIds : []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return new Map();
  const r = await client.query(
    `
      select id, owner_id, owner_type, file_name, mime_type, file_size_bytes, created_at
      from attachments
      where owner_type in ('quote_customer_datasheet', 'quote_engineering_datasheet')
        and owner_id = any($1::bigint[])
      order by created_at desc, id desc
    `,
    [ids]
  );
  const map = new Map();
  for (const row of r.rows) {
    const key = Number(row.owner_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      id: Number(row.id),
      owner_type: row.owner_type,
      file_name: row.file_name,
      mime_type: row.mime_type,
      file_size_bytes: Number(row.file_size_bytes || 0),
      created_at: row.created_at,
      direction: row.owner_type === "quote_engineering_datasheet" ? "engineering_return" : "customer_datasheet",
    });
  }
  return map;
}

async function ensureAssignableUser(client, companyId, userId) {
  if (!userId) return true;
  const r = await client.query(
    `
      select u.id
      from erp_users u
      join user_company_memberships ucm on ucm.user_id = u.id and ucm.company_id = $2 and ucm.is_active = true
      where u.id = $1
        and u.is_active = true
        and u.is_approved = true
      limit 1
    `,
    [Number(userId), Number(companyId)]
  );
  return Boolean(r.rows[0]?.id);
}

async function loadEngineeringAssignees(client, companyId) {
  const r = await client.query(
    `
      select
        u.id,
        u.full_name,
        u.email,
        u.department_key,
        case
          when lower(coalesce(u.department_key, '')) = 'engineering' then 0
          when lower(coalesce(u.department_key, '')) = 'manufacturing' then 1
          when lower(coalesce(u.department_key, '')) = 'quality' then 2
          else 9
        end as department_rank
      from erp_users u
      join user_company_memberships ucm
        on ucm.user_id = u.id
       and ucm.company_id = $1
       and ucm.is_active = true
      where u.is_active = true
        and u.is_approved = true
      order by department_rank asc, u.full_name asc, u.id asc
    `,
    [Number(companyId)]
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    full_name: row.full_name,
    email: row.email,
    department_key: row.department_key,
  }));
}

function buildQueueFilters({ q = "", bucket = "all" } = {}) {
  const params = [];
  const filters = [];
  const normalizedBucket = normalizeBucket(bucket);
  const query = cleanText(q);

  if (query) {
    params.push(`%${query}%`);
    const idx = params.length;
    filters.push(`(
      er.request_title ilike $${idx}
      or coalesce(er.customer_name, '') ilike $${idx}
      or coalesce(er.product_code, '') ilike $${idx}
      or coalesce(er.product_name, '') ilike $${idx}
      or coalesce(er.reference_no, '') ilike $${idx}
      or coalesce(er.request_details, '') ilike $${idx}
    )`);
  }

  if (normalizedBucket === "open") filters.push(`er.request_status not in ('closed', 'cancelled')`);
  if (normalizedBucket === "waiting_input") filters.push(`er.request_status = 'waiting_input'`);
  if (normalizedBucket === "datasheet") filters.push(`er.request_type = 'client_datasheet'`);
  if (normalizedBucket === "npd") filters.push(`er.request_type = 'npd'`);
  if (normalizedBucket === "bom_release") filters.push(`er.request_type = 'bom_release'`);
  if (normalizedBucket === "drawings") filters.push(`er.request_type = 'drawing'`);
  if (normalizedBucket === "technical") filters.push(`er.request_type = 'technical_data'`);
  if (normalizedBucket === "ready") filters.push(`er.request_status = 'ready'`);
  if (normalizedBucket === "urgent") filters.push(`er.request_status not in ('closed', 'cancelled') and er.request_priority in ('critical', 'high')`);
  if (normalizedBucket === "overdue") filters.push(`er.request_status not in ('closed', 'cancelled') and er.requested_due_date is not null and er.requested_due_date < current_date`);
  if (normalizedBucket === "sales_quote") filters.push(`er.quote_header_id is not null`);

  return { params, filters };
}

async function loadEngineeringSummary(client, companyId) {
  const hasQuoteLink = await client
    .query(`select to_regclass('public.engineering_requests') is not null as ready`)
    .then(async (r) => {
      if (!r.rows[0]?.ready) return false;
      const col = await client.query(
        `
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'engineering_requests'
            and column_name = 'quote_header_id'
          limit 1
        `
      );
      return Boolean(col.rows[0]);
    })
    .catch(() => false);

  const r = await client.query(
    `
      select
        count(*)::int as total_requests,
        count(*) filter (where request_status not in ('closed', 'cancelled'))::int as open_requests,
        count(*) filter (where request_type = 'client_datasheet' and request_status not in ('closed', 'cancelled'))::int as datasheet_open,
        count(*) filter (where request_type = 'npd' and request_status not in ('closed', 'cancelled'))::int as npd_open,
        count(*) filter (where request_type = 'drawing' and request_status not in ('closed', 'cancelled'))::int as drawing_open,
        count(*) filter (where request_type = 'technical_data' and request_status not in ('closed', 'cancelled'))::int as technical_open,
        count(*) filter (where request_type = 'bom_release' and request_status not in ('closed', 'cancelled'))::int as bom_release_open,
        count(*) filter (where request_status = 'ready')::int as ready_requests,
        count(*) filter (where request_status = 'waiting_input')::int as waiting_input_requests,
        count(*) filter (where request_status not in ('closed', 'cancelled') and request_priority in ('critical', 'high'))::int as urgent_open,
        count(*) filter (where request_status not in ('closed', 'cancelled') and requested_due_date is not null and requested_due_date < current_date)::int as overdue_open,
        ${hasQuoteLink ? "count(*) filter (where quote_header_id is not null and request_status not in ('closed', 'cancelled'))::int" : "0::int"} as quote_linked_open
      from engineering_requests
      where company_id = $1
    `,
    [Number(companyId)]
  );
  return (
    r.rows[0] || {
      total_requests: 0,
      open_requests: 0,
      datasheet_open: 0,
      npd_open: 0,
      drawing_open: 0,
      technical_open: 0,
      bom_release_open: 0,
      ready_requests: 0,
      waiting_input_requests: 0,
      urgent_open: 0,
      overdue_open: 0,
      quote_linked_open: 0,
    }
  );
}

async function loadEngineeringQueue(client, companyId, { q = "", bucket = "all", limit = 80 } = {}) {
  const { params, filters } = buildQueueFilters({ q, bucket });
  const scoped = [Number(companyId), ...params];
  const where = [`er.company_id = $1`, ...filters];
  const r = await client.query(
    `
      select
        er.*,
        qh.quote_number,
        requester.full_name as requester_name,
        assignee.full_name as assignee_name,
        creator.full_name as created_by_name,
        updater.full_name as updated_by_name
      from engineering_requests er
      left join quote_headers qh on qh.id = er.quote_header_id
      left join erp_users requester on requester.id = er.requester_user_id
      left join erp_users assignee on assignee.id = er.assigned_to_user_id
      left join erp_users creator on creator.id = er.created_by
      left join erp_users updater on updater.id = er.updated_by
      where ${where.join(" and ")}
      order by
        case er.request_priority
          when 'critical' then 0
          when 'high' then 1
          when 'normal' then 2
          else 3
        end asc,
        case
          when er.requested_due_date is null then 1
          else 0
        end asc,
        er.requested_due_date asc nulls last,
        er.created_at desc,
        er.id desc
      limit ${normalizeLimit(limit, 80, 200)}
    `,
    scoped
  );
  const rows = r.rows.map(mapRequestRow);
  const attachments = await loadRequestAttachments(
    client,
    rows.map((row) => row.id)
  );
  return rows.map((row) => ({ ...row, attachments: attachments.get(Number(row.id)) || [] }));
}

async function loadEngineeringRequestById(client, companyId, id) {
  const r = await client.query(
    `
      select
        er.*,
        qh.quote_number,
        requester.full_name as requester_name,
        assignee.full_name as assignee_name,
        creator.full_name as created_by_name,
        updater.full_name as updated_by_name
      from engineering_requests er
      left join quote_headers qh on qh.id = er.quote_header_id
      left join erp_users requester on requester.id = er.requester_user_id
      left join erp_users assignee on assignee.id = er.assigned_to_user_id
      left join erp_users creator on creator.id = er.created_by
      left join erp_users updater on updater.id = er.updated_by
      where er.company_id = $1 and er.id = $2
      limit 1
    `,
    [Number(companyId), Number(id)]
  );
  const mapped = mapRequestRow(r.rows[0] || null);
  if (!mapped) return null;
  const attachments = await loadRequestAttachments(client, [mapped.id]);
  return { ...mapped, attachments: attachments.get(Number(mapped.id)) || [] };
}

router.use(requireAuth);

router.get("/bootstrap", requireScreenAction("engineering_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket : "all";
    const limit = normalizeLimit(req.query.limit, 120, 200);
    const [summary, requests, assignees] = await Promise.all([
      loadEngineeringSummary(pool, companyId),
      loadEngineeringQueue(pool, companyId, { q, bucket, limit }),
      loadEngineeringAssignees(pool, companyId),
    ]);
    return res.json({ ok: true, summary, requests, assignees });
  } catch (err) {
    return next(err);
  }
});

router.post("/requests", requireScreenAction("engineering_desk", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const requestTitle = cleanText(body.request_title || body.title);
    if (!requestTitle) return res.status(400).json({ ok: false, error: "REQUEST_TITLE_REQUIRED" });
    const requestType = normalizeRequestType(body.request_type || body.type);
    const requestPriority = normalizeRequestPriority(body.request_priority || body.priority);
    const requestStatus = normalizeRequestStatus(body.request_status || body.status);
    const sourceDesk = normalizeSourceDesk(body.source_desk || body.source);
    const assignedToUserId = normalizeId(body.assigned_to_user_id || body.assignee_id);
    const quoteHeaderId = normalizeId(body.quote_header_id || body.quote_id);
    if (!(await ensureAssignableUser(client, companyId, assignedToUserId))) {
      return res.status(400).json({ ok: false, error: "ASSIGNEE_NOT_IN_COMPANY" });
    }
    const insertRes = await client.query(
      `
        insert into engineering_requests (
          company_id,
          request_type,
          request_title,
          request_status,
          request_priority,
          source_desk,
          requester_user_id,
          assigned_to_user_id,
          customer_name,
          product_code,
          product_name,
          reference_no,
          requested_due_date,
          request_details,
          attachment_note,
          quote_header_id,
          payload,
          created_by,
          updated_by,
          created_at,
          updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,coalesce($17::jsonb, '{}'::jsonb),$18,$19,now(),now())
        returning id
      `,
      [
        Number(companyId),
        requestType,
        requestTitle,
        requestStatus,
        requestPriority,
        sourceDesk,
        Number(req.user.id),
        assignedToUserId,
        cleanText(body.customer_name),
        cleanText(body.product_code),
        cleanText(body.product_name),
        cleanText(body.reference_no),
        cleanDate(body.requested_due_date),
        cleanText(body.request_details || body.details),
        cleanText(body.attachment_note),
        quoteHeaderId,
        body.payload && typeof body.payload === "object" ? JSON.stringify(body.payload) : null,
        Number(req.user.id),
        Number(req.user.id),
      ]
    );
    const request = await loadEngineeringRequestById(client, companyId, Number(insertRes.rows[0]?.id));
    if (request?.assigned_to_user_id) {
      notifyEngineeringAssigned({
        requestId: request.id,
        requestTitle: request.request_title,
        assignedToUserId: request.assigned_to_user_id,
        assignedBy: req.user.id,
        companyId,
      }).catch(() => {});
    }
    return res.status(201).json({ ok: true, request });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/requests/:id", requireScreenAction("engineering_desk", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const id = normalizeId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const existing = await loadEngineeringRequestById(client, companyId, id);
    if (!existing) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const assignedToUserId =
      body.assigned_to_user_id !== undefined || body.assignee_id !== undefined
        ? normalizeId(body.assigned_to_user_id || body.assignee_id)
        : existing.assigned_to_user_id;
    if (!(await ensureAssignableUser(client, companyId, assignedToUserId))) {
      return res.status(400).json({ ok: false, error: "ASSIGNEE_NOT_IN_COMPANY" });
    }

    const nextTitle = body.request_title !== undefined || body.title !== undefined ? cleanText(body.request_title || body.title) : existing.request_title;
    if (!nextTitle) return res.status(400).json({ ok: false, error: "REQUEST_TITLE_REQUIRED" });

    const nextQuoteHeaderId =
      body.quote_header_id !== undefined || body.quote_id !== undefined
        ? normalizeId(body.quote_header_id || body.quote_id)
        : existing.quote_header_id;

    await client.query(
      `
        update engineering_requests
        set request_type = $3,
            request_title = $4,
            request_status = $5,
            request_priority = $6,
            source_desk = $7,
            assigned_to_user_id = $8,
            customer_name = $9,
            product_code = $10,
            product_name = $11,
            reference_no = $12,
            requested_due_date = $13,
            request_details = $14,
            attachment_note = $15,
            quote_header_id = $16,
            payload = coalesce($17::jsonb, payload),
            updated_by = $18,
            updated_at = now()
        where company_id = $1 and id = $2
      `,
      [
        Number(companyId),
        Number(id),
        body.request_type !== undefined || body.type !== undefined ? normalizeRequestType(body.request_type || body.type) : existing.request_type,
        nextTitle,
        body.request_status !== undefined || body.status !== undefined ? normalizeRequestStatus(body.request_status || body.status) : existing.request_status,
        body.request_priority !== undefined || body.priority !== undefined ? normalizeRequestPriority(body.request_priority || body.priority) : existing.request_priority,
        body.source_desk !== undefined || body.source !== undefined ? normalizeSourceDesk(body.source_desk || body.source) : existing.source_desk,
        assignedToUserId,
        body.customer_name !== undefined ? cleanText(body.customer_name) : existing.customer_name,
        body.product_code !== undefined ? cleanText(body.product_code) : existing.product_code,
        body.product_name !== undefined ? cleanText(body.product_name) : existing.product_name,
        body.reference_no !== undefined ? cleanText(body.reference_no) : existing.reference_no,
        body.requested_due_date !== undefined ? cleanDate(body.requested_due_date) : existing.requested_due_date,
        body.request_details !== undefined || body.details !== undefined ? cleanText(body.request_details || body.details) : existing.request_details,
        body.attachment_note !== undefined ? cleanText(body.attachment_note) : existing.attachment_note,
        nextQuoteHeaderId,
        body.payload && typeof body.payload === "object" ? JSON.stringify(body.payload) : null,
        Number(req.user.id),
      ]
    );

    const request = await loadEngineeringRequestById(client, companyId, id);
    if (request?.assigned_to_user_id) {
      notifyEngineeringAssigned({
        requestId: request.id,
        requestTitle: request.request_title,
        assignedToUserId: request.assigned_to_user_id,
        assignedBy: req.user.id,
        companyId,
        previousAssigneeId: existing.assigned_to_user_id,
      }).catch(() => {});
    }
    const previousStatus = String(existing.request_status || "");
    const nextStatus = String(request?.request_status || "");
    if (
      request?.requester_user_id &&
      nextStatus &&
      nextStatus !== previousStatus &&
      (nextStatus === "ready" || nextStatus === "waiting_input")
    ) {
      notifyEngineeringSalesUpdate({
        requestId: request.id,
        requestTitle: request.request_title,
        requesterUserId: request.requester_user_id,
        quoteHeaderId: request.quote_header_id,
        companyId,
        actorUserId: req.user.id,
        status: nextStatus,
      }).catch(() => {});
    }
    return res.json({ ok: true, request });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post(
  "/requests/:id/response-datasheet",
  requireScreenAction("engineering_desk", "can_edit"),
  upload.single("file"),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const companyId = requireResolvedCompanyId(req);
      if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
      const id = normalizeId(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });
      if (!req.file) return res.status(400).json({ ok: false, error: "FILE_REQUIRED" });

      const existing = await loadEngineeringRequestById(client, companyId, id);
      if (!existing) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

      const originalName = String(req.file.originalname || "engineering_datasheet").trim() || "engineering_datasheet";
      const ext = path.extname(originalName);
      const baseName = safeFileSegment(path.basename(originalName, ext) || `eng_request_${id}_datasheet`);
      const fileName = `${baseName}_${Date.now()}${ext ? safeFileSegment(ext) : ""}`;
      const storageDir = path.resolve(__dirname, "..", "..", "storage", "engineering", "responses");
      fs.mkdirSync(storageDir, { recursive: true });
      const absFilePath = path.join(storageDir, fileName);
      fs.writeFileSync(absFilePath, req.file.buffer);

      await client.query("begin");
      const attach = await createOwnedAttachment(client, {
        fileName: originalName,
        filePath: absFilePath,
        mimeType: req.file.mimetype || "application/octet-stream",
        fileSizeBytes: req.file.size || req.file.buffer?.length || 0,
        uploadedBy: req.user.id,
        companyId,
        ownerType: "quote_engineering_datasheet",
        ownerId: id,
      });

      const markReady = String(req.body?.mark_ready || "").trim().toLowerCase() !== "false";
      if (markReady && isOpenStatus(existing.request_status)) {
        await client.query(
          `
            update engineering_requests
            set request_status = 'ready',
                updated_by = $3,
                updated_at = now()
            where company_id = $1 and id = $2
          `,
          [Number(companyId), Number(id), Number(req.user.id)]
        );
      } else {
        await client.query(
          `
            update engineering_requests
            set updated_by = $3, updated_at = now()
            where company_id = $1 and id = $2
          `,
          [Number(companyId), Number(id), Number(req.user.id)]
        );
      }
      await client.query("commit");

      const request = await loadEngineeringRequestById(pool, companyId, id);
      if (request?.requester_user_id && String(request.request_status || "") === "ready") {
        notifyEngineeringSalesUpdate({
          requestId: request.id,
          requestTitle: request.request_title,
          requesterUserId: request.requester_user_id,
          quoteHeaderId: request.quote_header_id,
          companyId,
          actorUserId: req.user.id,
          status: "ready",
        }).catch(() => {});
      }
      return res.status(201).json({
        ok: true,
        request,
        attachment: attach
          ? {
              id: Number(attach.id),
              file_name: attach.file_name || originalName,
              owner_type: "quote_engineering_datasheet",
              direction: "engineering_return",
            }
          : null,
      });
    } catch (err) {
      await client.query("rollback").catch(() => {});
      return next(err);
    } finally {
      client.release();
    }
  }
);

router.get("/requests/:id/attachments/:attachmentId", requireScreenAction("engineering_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const id = normalizeId(req.params.id);
    const attachmentId = normalizeId(req.params.attachmentId);
    if (!id || !attachmentId) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const r = await pool.query(
      `
        select a.id, a.file_name, a.file_path, a.mime_type
        from attachments a
        join engineering_requests er on er.id = a.owner_id and er.company_id = $1
        where er.id = $2
          and a.id = $3
          and a.owner_type in ('quote_customer_datasheet', 'quote_engineering_datasheet')
        limit 1
      `,
      [Number(companyId), Number(id), Number(attachmentId)]
    );
    const row = r.rows[0];
    if (!row?.file_path || !fs.existsSync(row.file_path)) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    res.setHeader("Content-Type", row.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileSegment(row.file_name || `attachment_${attachmentId}`)}"`);
    return res.sendFile(path.resolve(row.file_path));
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
