const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const { pool } = require("../db/pool");
const { hasScreenAction, ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { createOwnedAttachment } = require("../services/attachmentOwnership");
const { requireResolvedCompanyId } = require("../services/companyContext");
const { notifyServiceTicketAssigned, notifyServiceVisitCompleted } = require("../services/notifications");

const router = express.Router();

const MAX_REPORT_BYTES = 1.5 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_REPORT_BYTES },
});

const TICKET_STATUSES = new Set(["open", "assigned", "in_progress", "waiting_customer", "resolved", "closed", "cancelled"]);
const TICKET_PRIORITIES = new Set(["critical", "high", "normal", "low"]);
const COMPLAINT_TYPES = new Set(["complaint", "breakdown", "installation", "commissioning", "preventive", "other"]);
const VISIT_STATUSES = new Set(["scheduled", "checked_in", "completed", "missed", "cancelled"]);

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function cleanText(value, max = 2000) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, max);
}

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function cleanDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function ensureSignedReportDir() {
  const dir = path.resolve(__dirname, "..", "..", "storage", "service_tickets", "signed_reports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isReportFile(file) {
  if (!file) return false;
  const name = typeof file.originalname === "string" ? file.originalname.toLowerCase() : "";
  const mime = typeof file.mimetype === "string" ? file.mimetype.toLowerCase() : "";
  if (mime.startsWith("image/") || mime === "application/pdf") return true;
  return [".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif", ".pdf"].some((ext) => name.endsWith(ext));
}

function canAccessTicket(req, ticket) {
  if (!ticket) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "service_tickets")) return true;
  const uid = Number(req.user.id);
  return Number(ticket.assigned_to_user_id) === uid || Number(ticket.created_by) === uid;
}

async function loadTicketOrNull(client, companyId, ticketId) {
  const { rows } = await client.query(
    `
      select
        t.*,
        c.customer_name,
        ja.serial_no as job_asset_serial,
        ja.site_name as job_asset_site_name,
        ja.finished_good_item_code as job_asset_item_code,
        ja.finished_good_item_name as job_asset_item_name,
        assignee.full_name as assigned_to_name,
        assignee.email as assigned_to_email,
        creator.full_name as created_by_name,
        creator.email as created_by_email
      from service_tickets t
      join customers c on c.id = t.customer_id
      left join job_assets ja on ja.id = t.job_asset_id
      left join erp_users assignee on assignee.id = t.assigned_to_user_id
      left join erp_users creator on creator.id = t.created_by
      where t.id = $1
        and t.company_id = $2
      limit 1
    `,
    [ticketId, companyId]
  );
  return rows[0] || null;
}

async function loadVisits(client, ticketId) {
  const { rows } = await client.query(
    `
      select
        v.*,
        u.full_name as engineer_name,
        u.email as engineer_email,
        a.file_name as signed_report_file_name
      from service_ticket_visits v
      left join erp_users u on u.id = v.engineer_user_id
      left join attachments a on a.id = v.signed_report_attachment_id
      where v.ticket_id = $1
      order by v.visit_no asc, v.id asc
    `,
    [ticketId]
  );
  return rows.map((row) => ({
    ...row,
    has_signed_report: Boolean(row.signed_report_attachment_id),
  }));
}

async function loadAssetBom(client, jobAssetId) {
  if (!jobAssetId) return [];
  const { rows } = await client.query(
    `
      select
        id,
        installed_item_code,
        installed_item_name,
        qty_installed,
        uom,
        line_no
      from job_asset_bom_lines
      where job_asset_id = $1
      order by line_no asc nulls last, id asc
      limit 200
    `,
    [jobAssetId]
  );
  return rows;
}

router.use(requireAuth);

router.get("/bootstrap", requireScreenAction("service_tickets", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });

    const [customersRes, usersRes, assetsRes, dutyRes] = await Promise.all([
      client.query(
        `
          select c.id, c.customer_name, c.phone, c.email
          from customers c
          where exists (
            select 1 from customer_company_links ccl
            where ccl.customer_id = c.id and ccl.company_id = $1 and ccl.is_active = true
          )
          order by c.customer_name asc
          limit 500
        `,
        [companyId]
      ),
      client.query(
        `
          select u.id, u.full_name, u.email
          from erp_users u
          join user_company_memberships ucm
            on ucm.user_id = u.id and ucm.is_active = true and ucm.company_id = $1
          where u.is_active = true
          order by coalesce(u.full_name, u.email) asc
          limit 300
        `,
        [companyId]
      ),
      client.query(
        `
          select
            ja.id,
            ja.serial_no,
            ja.site_name,
            ja.finished_good_item_code,
            ja.finished_good_item_name,
            ja.customer_id
          from job_assets ja
          where ja.company_id = $1
          order by ja.updated_at desc nulls last, ja.id desc
          limit 400
        `,
        [companyId]
      ),
      client.query(
        `
          select
            id,
            attendance_date,
            attendance_status,
            to_char(in_time, 'HH24:MI') as in_time,
            to_char(out_time, 'HH24:MI') as out_time
          from hr_attendance_records
          where employee_user_id = $1
            and company_id = $2
            and attendance_date = current_date
          order by id desc
          limit 1
        `,
        [req.user.id, companyId]
      ).catch(() => ({ rows: [] })),
    ]);

    return res.json({
      ok: true,
      customers: customersRes.rows,
      users: usersRes.rows,
      job_assets: assetsRes.rows,
      field_my_day: dutyRes.rows[0] || null,
      note: "Field My Day (My Duty & Expenses) remains the attendance source of truth. Visit check-in only marks the site visit.",
    });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/summary", requireScreenAction("service_tickets", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
    const uid = asInt(req.user.id);
    const { rows } = await pool.query(
      `
        select
          count(*) filter (where ticket_status in ('open', 'assigned', 'in_progress', 'waiting_customer'))::int as open_count,
          count(*) filter (where assigned_to_user_id is null and ticket_status in ('open', 'assigned', 'in_progress', 'waiting_customer'))::int as unassigned_count,
          count(*) filter (
            where due_date is not null
              and due_date < current_date
              and ticket_status in ('open', 'assigned', 'in_progress', 'waiting_customer')
          )::int as overdue_count,
          count(*) filter (
            where assigned_to_user_id = $2
              and ticket_status in ('open', 'assigned', 'in_progress', 'waiting_customer')
          )::int as mine_count
        from service_tickets
        where company_id = $1
      `,
      [companyId, uid]
    );
    return res.json({ ok: true, summary: rows[0] || null });
  } catch (err) {
    return next(err);
  }
});

router.get("/schedule", requireScreenAction("service_tickets", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });

    const from = cleanDate(req.query.from) || new Date().toISOString().slice(0, 10);
    const toDate = new Date(`${from}T00:00:00`);
    toDate.setDate(toDate.getDate() + 6);
    const to = cleanDate(req.query.to) || toDate.toISOString().slice(0, 10);
    const engineerId = asInt(req.query.engineer_id);

    const params = [companyId, from, to];
    const where = [
      `t.company_id = $1`,
      `v.scheduled_date is not null`,
      `v.scheduled_date >= $2::date`,
      `v.scheduled_date <= $3::date`,
      `v.visit_status <> 'cancelled'`,
    ];
    if (engineerId) {
      params.push(engineerId);
      where.push(`v.engineer_user_id = $${params.length}`);
    }
    if (ownRecordsOnly(req, "service_tickets") && req.user.group_name !== "SuperAdmin") {
      params.push(asInt(req.user.id));
      where.push(`(v.engineer_user_id = $${params.length} or t.assigned_to_user_id = $${params.length} or t.created_by = $${params.length})`);
    }

    const { rows } = await pool.query(
      `
        select
          v.id as visit_id,
          v.ticket_id,
          v.visit_no,
          v.scheduled_date,
          v.visit_status,
          v.engineer_user_id,
          u.full_name as engineer_name,
          t.ticket_number,
          t.ticket_status,
          t.ticket_priority,
          t.site_name,
          t.customer_id,
          c.customer_name,
          t.resolve_by_at,
          t.first_response_at
        from service_ticket_visits v
        join service_tickets t on t.id = v.ticket_id
        join customers c on c.id = t.customer_id
        left join erp_users u on u.id = v.engineer_user_id
        where ${where.join(" and ")}
        order by v.scheduled_date asc, coalesce(u.full_name, ''), v.visit_no asc, v.id asc
      `,
      params
    );

    const byDate = {};
    for (const row of rows) {
      const key = String(row.scheduled_date).slice(0, 10);
      if (!byDate[key]) byDate[key] = [];
      byDate[key].push(row);
    }

    return res.json({ ok: true, from, to, visits: rows, by_date: byDate });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("service_tickets", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
    const status = cleanText(req.query.status, 40);
    const assignedTo = cleanText(req.query.assigned_to, 40);
    const q = cleanText(req.query.q, 120);
    const params = [companyId];
    const where = ["t.company_id = $1"];

    if (status && TICKET_STATUSES.has(status)) {
      params.push(status);
      where.push(`t.ticket_status = $${params.length}`);
    }
    if (assignedTo === "me") {
      params.push(asInt(req.user.id));
      where.push(`t.assigned_to_user_id = $${params.length}`);
    } else if (assignedTo === "unassigned") {
      where.push(`t.assigned_to_user_id is null`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(
        `(t.ticket_number ilike $${params.length} or t.symptom_summary ilike $${params.length} or c.customer_name ilike $${params.length} or coalesce(t.site_name,'') ilike $${params.length})`
      );
    }
    if (ownRecordsOnly(req, "service_tickets") && req.user.group_name !== "SuperAdmin") {
      params.push(asInt(req.user.id));
      where.push(`(t.assigned_to_user_id = $${params.length} or t.created_by = $${params.length})`);
    }

    const { rows } = await pool.query(
      `
        select
          t.id,
          t.ticket_number,
          t.ticket_status,
          t.ticket_priority,
          t.complaint_type,
          t.customer_id,
          c.customer_name,
          t.job_asset_id,
          t.assigned_to_user_id,
          assignee.full_name as assigned_to_name,
          t.site_name,
          t.symptom_summary,
          t.due_date,
          t.created_at,
          t.updated_at
        from service_tickets t
        join customers c on c.id = t.customer_id
        left join erp_users assignee on assignee.id = t.assigned_to_user_id
        where ${where.join(" and ")}
        order by
          case t.ticket_status
            when 'open' then 0 when 'assigned' then 1 when 'in_progress' then 2
            when 'waiting_customer' then 3 else 4
          end,
          t.created_at desc
        limit 200
      `,
      params
    );
    return res.json({ ok: true, tickets: rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireScreenAction("service_tickets", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const customerId = asInt(body.customer_id);
    const symptom = cleanText(body.symptom_summary, 4000);
    if (!customerId || !symptom) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });

    const priority = TICKET_PRIORITIES.has(String(body.ticket_priority || "")) ? body.ticket_priority : "normal";
    const complaintType = COMPLAINT_TYPES.has(String(body.complaint_type || "")) ? body.complaint_type : "complaint";
    const jobAssetId = asInt(body.job_asset_id);
    const assignedTo = asInt(body.assigned_to_user_id);

    await client.query("begin");
    const numRes = await client.query(`select next_company_document_number($1, 'STK') as ticket_number`, [companyId]);
    const ticketNumber = numRes.rows[0]?.ticket_number;
    const status = assignedTo ? "assigned" : "open";

    const insertRes = await client.query(
      `
        insert into service_tickets (
          company_id, ticket_number, ticket_status, ticket_priority, complaint_type,
          customer_id, job_asset_id, assigned_to_user_id, site_name, site_address,
          reported_by, symptom_summary, remarks, due_date, created_by, updated_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
        returning id
      `,
      [
        companyId,
        ticketNumber,
        status,
        priority,
        complaintType,
        customerId,
        jobAssetId,
        assignedTo,
        cleanText(body.site_name, 200),
        cleanText(body.site_address, 500),
        cleanText(body.reported_by, 160),
        symptom,
        cleanText(body.remarks, 2000),
        cleanDate(body.due_date),
        req.user.id,
      ]
    );
    const ticketId = Number(insertRes.rows[0].id);

    if (assignedTo) {
      await client.query(
        `
          insert into service_ticket_assignments (ticket_id, assigned_to, assigned_by, assignment_reason)
          values ($1,$2,$3,$4)
        `,
        [ticketId, assignedTo, req.user.id, "Assigned on creation"]
      );
    }

    const ticket = await loadTicketOrNull(client, companyId, ticketId);
    await client.query("commit");

    if (assignedTo) {
      notifyServiceTicketAssigned({
        ticketId,
        ticketNumber: ticket?.ticket_number,
        assignedToUserId: assignedTo,
        assignedBy: req.user.id,
        companyId,
        customerName: ticket?.customer_name,
      }).catch(() => {});
    }

    return res.status(201).json({ ok: true, ticket, visits: [], asset_bom_lines: [] });
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

router.get("/:id", requireScreenAction("service_tickets", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const ticket = await loadTicketOrNull(client, companyId, id);
    if (!ticket) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessTicket(req, ticket)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const [visits, bom] = await Promise.all([loadVisits(client, id), loadAssetBom(client, ticket.job_asset_id)]);
    return res.json({ ok: true, ticket, visits, asset_bom_lines: bom });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/:id", requireScreenAction("service_tickets", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const existing = await loadTicketOrNull(client, companyId, id);
    if (!existing) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessTicket(req, existing)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const nextStatus = body.ticket_status != null && TICKET_STATUSES.has(String(body.ticket_status))
      ? String(body.ticket_status)
      : existing.ticket_status;
    const nextPriority = body.ticket_priority != null && TICKET_PRIORITIES.has(String(body.ticket_priority))
      ? String(body.ticket_priority)
      : existing.ticket_priority;
    const nextType = body.complaint_type != null && COMPLAINT_TYPES.has(String(body.complaint_type))
      ? String(body.complaint_type)
      : existing.complaint_type;
    const jobAssetId = body.job_asset_id !== undefined ? asInt(body.job_asset_id) : existing.job_asset_id;

    await client.query(
      `
        update service_tickets
        set ticket_status = $3,
            ticket_priority = $4,
            complaint_type = $5,
            job_asset_id = $6,
            site_name = coalesce($7, site_name),
            site_address = coalesce($8, site_address),
            reported_by = coalesce($9, reported_by),
            symptom_summary = coalesce($10, symptom_summary),
            remarks = coalesce($11, remarks),
            due_date = coalesce($12, due_date),
            resolved_at = case when $3 in ('resolved', 'closed') then coalesce(resolved_at, now()) else resolved_at end,
            updated_by = $13,
            updated_at = now()
        where id = $1 and company_id = $2
      `,
      [
        id,
        companyId,
        nextStatus,
        nextPriority,
        nextType,
        jobAssetId,
        body.site_name !== undefined ? cleanText(body.site_name, 200) : null,
        body.site_address !== undefined ? cleanText(body.site_address, 500) : null,
        body.reported_by !== undefined ? cleanText(body.reported_by, 160) : null,
        body.symptom_summary !== undefined ? cleanText(body.symptom_summary, 4000) : null,
        body.remarks !== undefined ? cleanText(body.remarks, 2000) : null,
        body.due_date !== undefined ? cleanDate(body.due_date) : null,
        req.user.id,
      ]
    );

    const ticket = await loadTicketOrNull(client, companyId, id);
    const [visits, bom] = await Promise.all([loadVisits(client, id), loadAssetBom(client, ticket.job_asset_id)]);
    return res.json({ ok: true, ticket, visits, asset_bom_lines: bom });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/assign", requireScreenAction("service_tickets", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
    const id = asInt(req.params.id);
    const assigneeId = asInt(req.body?.assigned_to_user_id);
    if (!id || !assigneeId) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });

    const existing = await loadTicketOrNull(client, companyId, id);
    if (!existing) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    await client.query("begin");
    const slaHours = Math.max(1, Math.min(168, asInt(req.body?.assign_sla_hours) || 24));
    await client.query(
      `
        update service_tickets
        set assigned_to_user_id = $3,
            ticket_status = case when ticket_status = 'open' then 'assigned' else ticket_status end,
            assign_sla_hours = coalesce(assign_sla_hours, $5),
            resolve_by_at = coalesce(resolve_by_at, now() + make_interval(hours => $5)),
            updated_by = $4,
            updated_at = now()
        where id = $1 and company_id = $2
      `,
      [id, companyId, assigneeId, req.user.id, slaHours]
    );
    await client.query(
      `
        insert into service_ticket_assignments (ticket_id, assigned_to, assigned_by, assignment_reason)
        values ($1,$2,$3,$4)
      `,
      [id, assigneeId, req.user.id, cleanText(req.body?.reason, 400) || "Manual assignment"]
    );
    const ticket = await loadTicketOrNull(client, companyId, id);
    await client.query("commit");

    notifyServiceTicketAssigned({
      ticketId: id,
      ticketNumber: ticket?.ticket_number,
      assignedToUserId: assigneeId,
      assignedBy: req.user.id,
      companyId,
      customerName: ticket?.customer_name,
    }).catch(() => {});

    const visits = await loadVisits(pool, id);
    const bom = await loadAssetBom(pool, ticket.job_asset_id);
    return res.json({ ok: true, ticket, visits, asset_bom_lines: bom });
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

router.post("/:id/visits", requireScreenAction("service_tickets", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const ticket = await loadTicketOrNull(client, companyId, id);
    if (!ticket) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!ticket.job_asset_id) {
      return res.status(400).json({
        ok: false,
        error: "JOB_ASSET_REQUIRED",
        detail: "Link a job asset (installed package) before scheduling a site visit.",
      });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const engineerId = asInt(body.engineer_user_id) || ticket.assigned_to_user_id;
    const visitNoRes = await client.query(
      `select coalesce(max(visit_no), 0) + 1 as next_no from service_ticket_visits where ticket_id = $1`,
      [id]
    );
    const visitNo = Number(visitNoRes.rows[0]?.next_no || 1);

    await client.query(
      `
        insert into service_ticket_visits (
          ticket_id, visit_no, scheduled_date, visit_status, engineer_user_id, visit_notes, created_by, updated_by
        )
        values ($1,$2,$3,'scheduled',$4,$5,$6,$6)
      `,
      [id, visitNo, cleanDate(body.scheduled_date), engineerId, cleanText(body.visit_notes, 2000), req.user.id]
    );

    if (ticket.ticket_status === "open" || ticket.ticket_status === "assigned") {
      await client.query(
        `update service_tickets set ticket_status = 'in_progress', updated_by = $2, updated_at = now() where id = $1`,
        [id, req.user.id]
      );
    }

    const refreshed = await loadTicketOrNull(client, companyId, id);
    const visits = await loadVisits(client, id);
    const bom = await loadAssetBom(client, refreshed.job_asset_id);
    return res.status(201).json({ ok: true, ticket: refreshed, visits, asset_bom_lines: bom });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/:id/visits/:visitId", requireScreenAction("service_tickets", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
    const id = asInt(req.params.id);
    const visitId = asInt(req.params.visitId);
    if (!id || !visitId) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const ticket = await loadTicketOrNull(client, companyId, id);
    if (!ticket) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const action = cleanText(body.action, 40);
    let nextStatus =
      body.visit_status && VISIT_STATUSES.has(String(body.visit_status)) ? String(body.visit_status) : null;
    if (action === "check_in") nextStatus = "checked_in";
    if (action === "check_out") nextStatus = "completed";

    const visitRes = await client.query(
      `select * from service_ticket_visits where id = $1 and ticket_id = $2 limit 1 for update`,
      [visitId, id]
    );
    const existingVisit = visitRes.rows[0];
    if (!existingVisit) return res.status(404).json({ ok: false, error: "VISIT_NOT_FOUND" });

    const finalStatus = nextStatus || existingVisit.visit_status;
    const checkedInAt =
      finalStatus === "checked_in" || finalStatus === "completed"
        ? existingVisit.checked_in_at || new Date()
        : existingVisit.checked_in_at;
    const checkedOutAt =
      finalStatus === "completed" ? existingVisit.checked_out_at || new Date() : existingVisit.checked_out_at;

    const upd = await client.query(
      `
        update service_ticket_visits
        set visit_status = $3,
            checked_in_at = $4,
            checked_out_at = $5,
            visit_notes = coalesce($6, visit_notes),
            customer_signatory_name = coalesce($7, customer_signatory_name),
            signed_at = case when $7 is not null then coalesce(signed_at, now()) else signed_at end,
            engineer_user_id = coalesce($8, engineer_user_id),
            scheduled_date = coalesce($9, scheduled_date),
            updated_by = $10,
            updated_at = now()
        where id = $1 and ticket_id = $2
        returning *
      `,
      [
        visitId,
        id,
        finalStatus,
        checkedInAt,
        checkedOutAt,
        body.visit_notes !== undefined ? cleanText(body.visit_notes, 2000) : null,
        body.customer_signatory_name !== undefined ? cleanText(body.customer_signatory_name, 160) : null,
        body.engineer_user_id !== undefined ? asInt(body.engineer_user_id) : null,
        body.scheduled_date !== undefined ? cleanDate(body.scheduled_date) : null,
        req.user.id,
      ]
    );
    const visit = upd.rows[0];
    if (finalStatus === "checked_in" || finalStatus === "completed") {
      await client.query(
        `
          update service_tickets
          set first_response_at = coalesce(first_response_at, now()),
              updated_at = now(),
              updated_by = $3
          where id = $1 and company_id = $2
        `,
        [id, companyId, req.user.id]
      ).catch(() => {});
    }
    if (visit.visit_status === "completed") {
      notifyServiceVisitCompleted({
        ticketId: id,
        ticketNumber: ticket.ticket_number,
        companyId,
        createdByUserId: ticket.created_by,
        actorUserId: req.user.id,
        visitStatus: "completed",
        hasSignedReport: Boolean(visit.signed_report_attachment_id),
      }).catch(() => {});
    }

    const refreshed = await loadTicketOrNull(client, companyId, id);
    const visits = await loadVisits(client, id);
    const bom = await loadAssetBom(client, refreshed.job_asset_id);
    return res.json({
      ok: true,
      ticket: refreshed,
      visits,
      asset_bom_lines: bom,
      field_my_day_note:
        "Visit check-in/out marks the site visit only. Keep punch in/out in Field My Day (My Duty & Expenses).",
    });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post(
  "/:id/visits/:visitId/signed-report",
  requireScreenAction("service_tickets", "can_edit"),
  (req, res, next) => {
    upload.single("signed_report")(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ ok: false, error: "REPORT_TOO_LARGE" });
        return res.status(400).json({ ok: false, error: "UPLOAD_FAILED", detail: String(err.message || err) });
      }
      return next();
    });
  },
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const companyId = requireResolvedCompanyId(req);
      if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
      const id = asInt(req.params.id);
      const visitId = asInt(req.params.visitId);
      const file = req.file;
      if (!id || !visitId) return res.status(400).json({ ok: false, error: "INVALID_ID" });
      if (!isReportFile(file)) return res.status(400).json({ ok: false, error: "REPORT_REQUIRED" });

      const ticket = await loadTicketOrNull(client, companyId, id);
      if (!ticket) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

      await client.query("begin");
      const dir = ensureSignedReportDir();
      const stored = `signed_${id}_${visitId}_${Date.now()}.jpg`;
      const absPath = path.join(dir, stored);
      fs.writeFileSync(absPath, file.buffer);

      const attach = await createOwnedAttachment(client, {
        fileName: file.originalname || stored,
        filePath: absPath,
        mimeType: file.mimetype || "image/jpeg",
        fileSizeBytes: file.size || file.buffer.length || 0,
        uploadedBy: req.user.id,
        companyId,
        ownerType: "service_signed_report",
        ownerId: visitId,
        visibilityScope: "company",
      });
      if (!attach?.id) {
        await client.query("rollback");
        return res.status(500).json({ ok: false, error: "ATTACHMENT_FAILED" });
      }

      const signatory = cleanText(req.body?.customer_signatory_name, 160);
      await client.query(
        `
          update service_ticket_visits
          set signed_report_attachment_id = $3,
              customer_signatory_name = coalesce($4, customer_signatory_name),
              signed_at = now(),
              visit_status = case when visit_status in ('scheduled', 'checked_in') then 'completed' else visit_status end,
              checked_out_at = coalesce(checked_out_at, now()),
              updated_by = $5,
              updated_at = now()
          where id = $1 and ticket_id = $2
        `,
        [visitId, id, attach.id, signatory, req.user.id]
      );
      await client.query("commit");

      notifyServiceVisitCompleted({
        ticketId: id,
        ticketNumber: ticket.ticket_number,
        companyId,
        createdByUserId: ticket.created_by,
        actorUserId: req.user.id,
        visitStatus: "completed",
        hasSignedReport: true,
      }).catch(() => {});

      const refreshed = await loadTicketOrNull(pool, companyId, id);
      const visits = await loadVisits(pool, id);
      const bom = await loadAssetBom(pool, refreshed.job_asset_id);
      return res.status(201).json({ ok: true, ticket: refreshed, visits, asset_bom_lines: bom });
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
  }
);

router.get("/:id/visits/:visitId/signed-report", requireScreenAction("service_tickets", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
    const id = asInt(req.params.id);
    const visitId = asInt(req.params.visitId);
    if (!id || !visitId) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const { rows } = await pool.query(
      `
        select a.file_path, a.mime_type, a.file_name
        from service_ticket_visits v
        join service_tickets t on t.id = v.ticket_id
        join attachments a on a.id = v.signed_report_attachment_id
        where v.id = $1 and v.ticket_id = $2 and t.company_id = $3
        limit 1
      `,
      [visitId, id, companyId]
    );
    const row = rows[0];
    if (!row?.file_path || !fs.existsSync(row.file_path)) {
      return res.status(404).json({ ok: false, error: "FILE_MISSING" });
    }
    res.setHeader("Content-Type", row.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${String(row.file_name || "signed-report").replace(/"/g, "")}"`);
    return fs.createReadStream(row.file_path).pipe(res);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
