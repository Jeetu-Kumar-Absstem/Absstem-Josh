const express = require("express");

const { pool } = require("../db/pool");
const { hasScreenAction, requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const { notifyExpenseApprovalNeeded, notifyLeaveApprovalNeeded } = require("../services/notifications");

const router = express.Router();

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

function cleanTime(value) {
  const text = cleanText(value);
  if (!text) return null;
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(text)) return text.length === 5 ? `${text}:00` : text;
  return null;
}

function cleanAmount(value) {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : 0;
}

function normalizeAttendanceStatus(value) {
  const allowed = new Set(["present", "late_mark", "missing_punch", "leave", "regularization_pending", "shift_pending"]);
  const raw = String(value || "").trim().toLowerCase();
  return allowed.has(raw) ? raw : "present";
}

function normalizeExpenseStatus(value) {
  const allowed = new Set(["manager_pending", "accounts_pending", "reimbursed", "returned"]);
  const raw = String(value || "").trim().toLowerCase();
  return allowed.has(raw) ? raw : "manager_pending";
}

function normalizePlannerStage(value) {
  const allowed = new Set(["planned", "today", "in_progress", "under_review", "done", "overdue"]);
  const raw = String(value || "").trim().toLowerCase();
  return allowed.has(raw) ? raw : "planned";
}

function normalizePriority(value) {
  const allowed = new Set(["low", "medium", "high"]);
  const raw = String(value || "").trim().toLowerCase();
  return allowed.has(raw) ? raw : "medium";
}

function normalizeEventStatus(value) {
  const allowed = new Set(["registration_open", "itinerary_pending", "slots_filling", "published"]);
  const raw = String(value || "").trim().toLowerCase();
  return allowed.has(raw) ? raw : "registration_open";
}

function ensureHrApprovalAccess(req, res, screenKey, detail) {
  if (hasScreenAction(req, screenKey, "can_approve")) return true;
  res.status(403).json({
    ok: false,
    error: "FORBIDDEN",
    detail,
  });
  return false;
}

function attendanceAlertFromRow(row) {
  const issueMap = {
    missing_punch: "Missing punch",
    late_mark: "Late mark needs review",
    regularization_pending: "Regularization pending",
    shift_pending: "Shift not confirmed",
    leave: "Leave marked",
    present: "Attendance updated",
  };
  const actionMap = {
    missing_punch: "Review regularization",
    late_mark: "Check attendance pattern",
    regularization_pending: "Approve correction",
    shift_pending: "Lock roster",
    leave: "Confirm leave entry",
    present: "Review attendance",
  };
  const levelMap = {
    missing_punch: "warning",
    late_mark: "danger",
    regularization_pending: "info",
    shift_pending: "info",
    leave: "info",
    present: "info",
  };
  return {
    id: row.id,
    employee: row.employee_name,
    issue: issueMap[row.attendance_status] || "Attendance review",
    day: row.attendance_date,
    action: actionMap[row.attendance_status] || "Open attendance",
    level: levelMap[row.attendance_status] || "info",
  };
}

function expenseAlertFromRow(row) {
  return {
    id: row.id,
    employee: row.employee_name,
    claim: row.purpose,
    amount: Number(row.amount || 0),
    status: row.claim_status,
    action:
      row.claim_status === "manager_pending"
        ? "Approve manager review"
        : row.claim_status === "accounts_pending"
          ? "Send to Accounts"
          : row.claim_status === "returned"
            ? "Clarify supporting bill"
            : "Review claim",
  };
}

function plannerAlertFromRow(row) {
  const dueDate = row.due_date ? String(row.due_date).slice(0, 10) : "";
  const isOverdue = dueDate && dueDate < new Date().toISOString().slice(0, 10) && row.activity_stage !== "done";
  return {
    id: row.id,
    owner: row.owner_name,
    title: row.title,
    due: isOverdue ? "Overdue" : dueDate,
    status: isOverdue ? "overdue" : row.activity_stage,
    action: isOverdue ? "Close pending tasks" : "Review plan",
  };
}

function eventAlertFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    date: row.event_date ? String(row.event_date).slice(0, 10) : "",
    status: row.event_status,
    action:
      row.event_status === "itinerary_pending"
        ? "Publish itinerary"
        : row.event_status === "published"
          ? "Watch participation"
          : "Broadcast reminder",
  };
}

function leaveAlertFromRow(row) {
  return {
    id: row.id,
    employee: row.employee_name,
    issue: `${row.leave_type} leave`,
    day: row.start_date ? String(row.start_date).slice(0, 10) : "",
    action: row.leave_status === "pending" ? "Review leave request" : "Track leave",
    level: row.leave_status === "pending" ? "warning" : "info",
  };
}

function salarySlipAlertFromRow(row) {
  return {
    id: row.id,
    employee: row.employee_name,
    claim: `Salary slip ${row.payroll_month ? String(row.payroll_month).slice(0, 7) : ""}`,
    amount: Number(row.net_salary || 0),
    status: row.slip_status,
    action: row.slip_status === "paid" ? "Review payout" : "Mark salary paid",
  };
}

async function resolveUserContext(client, companyId, nameText) {
  const name = cleanText(nameText);
  if (!name) return { userId: null, displayName: null, departmentName: null };
  const { rows } = await client.query(
    `
      select
        u.id,
        coalesce(nullif(u.full_name, ''), $2) as full_name,
        d.department_name
      from erp_users u
      join user_company_memberships ucm
        on ucm.user_id = u.id
       and ucm.company_id = $1
       and ucm.is_active = true
      left join departments d
        on d.id = u.department_id
      where u.is_active = true
        and lower(coalesce(u.full_name, '')) = lower($2)
      order by u.id desc
      limit 1
    `,
    [companyId, name]
  );
  if (!rows[0]) return { userId: null, displayName: name, departmentName: null };
  return {
    userId: Number(rows[0].id),
    displayName: rows[0].full_name || name,
    departmentName: rows[0].department_name || null,
  };
}

function requireAnyHrView(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (
    hasScreenAction(req, "hr_desk", "can_view") ||
    hasScreenAction(req, "attendance", "can_view") ||
    hasScreenAction(req, "expenses", "can_view") ||
    hasScreenAction(req, "activity_planner", "can_view") ||
    hasScreenAction(req, "events", "can_view") ||
    hasScreenAction(req, "leave", "can_view") ||
    hasScreenAction(req, "holidays", "can_view") ||
    hasScreenAction(req, "salary", "can_view") ||
    hasScreenAction(req, "salary_slips", "can_view") ||
    hasScreenAction(req, "my_duty_expenses", "can_view")
  ) {
    return next();
  }
  return res.status(403).json({ ok: false, error: "FORBIDDEN" });
}

router.use(requireAuth);

router.get("/desk", requireAnyHrView, async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const [attendanceRes, expenseRes, plannerRes, eventRes, leaveRes, salarySlipRes] = await Promise.all([
      pool.query(
        `
          select id, employee_name, attendance_status, attendance_date
          from hr_attendance_records
          where company_id = $1
            and attendance_status in ('late_mark', 'missing_punch', 'regularization_pending', 'shift_pending')
          order by attendance_date desc, updated_at desc
          limit 6
        `,
        [companyId]
      ),
      pool.query(
        `
          select id, employee_name, purpose, amount, claim_status
          from hr_expense_claims
          where company_id = $1
            and claim_status in ('manager_pending', 'accounts_pending', 'returned')
          order by updated_at desc
          limit 6
        `,
        [companyId]
      ),
      pool.query(
        `
          select id, owner_name, title, due_date, activity_stage
          from hr_planner_activities
          where company_id = $1
            and activity_stage <> 'done'
          order by due_date asc, updated_at desc
          limit 6
        `,
        [companyId]
      ),
      pool.query(
        `
          select id, title, event_date, event_status
          from hr_events
          where company_id = $1
            and event_status in ('registration_open', 'itinerary_pending', 'slots_filling')
          order by event_date asc, updated_at desc
          limit 6
        `,
        [companyId]
      ),
      pool.query(
        `
          select id, employee_name, leave_type, start_date, leave_status
          from hr_leave_requests
          where company_id = $1
            and leave_status = 'pending'
          order by start_date asc, updated_at desc
          limit 6
        `,
        [companyId]
      ),
      pool.query(
        `
          select id, employee_name, payroll_month, net_salary, slip_status
          from hr_salary_slips
          where company_id = $1
            and slip_status <> 'paid'
          order by payroll_month desc, updated_at desc
          limit 6
        `,
        [companyId]
      ),
    ]);

    return res.json({
      ok: true,
      attendance_alerts: attendanceRes.rows.map(attendanceAlertFromRow),
      expense_alerts: expenseRes.rows.map(expenseAlertFromRow),
      planner_alerts: plannerRes.rows.map(plannerAlertFromRow),
      event_alerts: eventRes.rows.map(eventAlertFromRow),
      leave_alerts: leaveRes.rows.map(leaveAlertFromRow),
      salary_slip_alerts: salarySlipRes.rows.map(salarySlipAlertFromRow),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/attendance", requireScreenAction("attendance", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const { rows } = await pool.query(
      `
        select
          id,
          employee_name as employee,
          coalesce(department_name, 'General') as department,
          coalesce(shift_name, 'General') as shift,
          attendance_status as status,
          to_char(in_time, 'HH24:MI') as in_time,
          to_char(out_time, 'HH24:MI') as out_time,
          coalesce(note, '') as note,
          attendance_date
        from hr_attendance_records
        where company_id = $1
        order by attendance_date desc, updated_at desc, id desc
        limit 200
      `,
      [companyId]
    );
    return res.json({ ok: true, rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/attendance", requireScreenAction("attendance", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const employee = cleanText(req.body?.employee);
    const attendanceDate = cleanDate(req.body?.date) || new Date().toISOString().slice(0, 10);
    const reason = cleanText(req.body?.reason);
    if (!employee || !reason) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });

    const resolved = await resolveUserContext(client, companyId, employee);
    const { rows } = await client.query(
      `
        insert into hr_attendance_records (
          company_id,
          employee_user_id,
          employee_name,
          department_name,
          shift_name,
          attendance_status,
          attendance_date,
          note,
          created_by,
          updated_by
        )
        values ($1,$2,$3,$4,'General','regularization_pending',$5,$6,$7,$7)
        returning
          id,
          employee_name as employee,
          coalesce(department_name, 'General') as department,
          coalesce(shift_name, 'General') as shift,
          attendance_status as status,
          to_char(in_time, 'HH24:MI') as in_time,
          to_char(out_time, 'HH24:MI') as out_time,
          coalesce(note, '') as note,
          attendance_date
      `,
      [companyId, resolved.userId, resolved.displayName || employee, resolved.departmentName, attendanceDate, reason, req.user.id]
    );
    return res.status(201).json({ ok: true, row: rows[0] });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.patch("/attendance/:id", requireScreenAction("attendance", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const status = normalizeAttendanceStatus(req.body?.status);
    const note = cleanText(req.body?.note);
    const outTime = cleanTime(req.body?.out_time);
    const { rows } = await client.query(
      `
        update hr_attendance_records
        set attendance_status = $3,
            note = coalesce($4, note),
            out_time = coalesce($5, out_time),
            updated_by = $6,
            updated_at = now()
        where id = $1
          and company_id = $2
        returning
          id,
          employee_name as employee,
          coalesce(department_name, 'General') as department,
          coalesce(shift_name, 'General') as shift,
          attendance_status as status,
          to_char(in_time, 'HH24:MI') as in_time,
          to_char(out_time, 'HH24:MI') as out_time,
          coalesce(note, '') as note,
          attendance_date
      `,
      [id, companyId, status, note, outTime, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "ATTENDANCE_NOT_FOUND" });
    return res.json({ ok: true, row: rows[0] });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/expenses", requireScreenAction("expenses", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const { rows } = await pool.query(
      `
        select
          id,
          employee_name as employee,
          purpose,
          category,
          amount,
          claim_status as status,
          coalesce(bill_status, '') as bill_status,
          coalesce(reference_no, '') as reference_no,
          receipt_attachment_id,
          source_channel,
          job_card_id,
          service_case_id
        from hr_expense_claims
        where company_id = $1
        order by updated_at desc, id desc
        limit 200
      `,
      [companyId]
    );
    return res.json({ ok: true, claims: rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/expenses", requireScreenAction("expenses", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const employee = cleanText(req.body?.employee);
    const purpose = cleanText(req.body?.purpose);
    const category = cleanText(req.body?.category) || "Travel";
    const amount = cleanAmount(req.body?.amount);
    if (!employee || !purpose || amount <= 0) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    const resolved = await resolveUserContext(client, companyId, employee);
    const { rows } = await client.query(
      `
        insert into hr_expense_claims (
          company_id,
          employee_user_id,
          employee_name,
          purpose,
          category,
          amount,
          claim_status,
          bill_status,
          created_by,
          updated_by
        )
        values ($1,$2,$3,$4,$5,$6,'manager_pending','Waiting for manager approval',$7,$7)
        returning
          id,
          employee_name as employee,
          purpose,
          category,
          amount,
          claim_status as status,
          coalesce(bill_status, '') as bill_status
      `,
      [companyId, resolved.userId, resolved.displayName || employee, purpose, category, amount, req.user.id]
    );
    if (rows[0]?.id) {
      notifyExpenseApprovalNeeded({
        claimId: rows[0].id,
        employeeUserId: resolved.userId,
        employeeName: rows[0].employee,
        purpose: rows[0].purpose,
        amount: rows[0].amount,
        companyId,
        actorUserId: req.user.id,
      }).catch(() => {});
    }
    return res.status(201).json({ ok: true, claim: rows[0] });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.patch("/expenses/:id", requireScreenAction("expenses", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const status = normalizeExpenseStatus(req.body?.status);
    if (!ensureHrApprovalAccess(req, res, "expenses", "You do not have approval rights for expense decisions.")) return;
    const billStatus =
      cleanText(req.body?.bill_status) ||
      (status === "accounts_pending"
        ? "Manager approved"
        : status === "reimbursed"
          ? "Payment processed"
          : status === "returned"
            ? "Need clarification"
            : null);
    const { rows } = await client.query(
      `
        update hr_expense_claims
        set claim_status = $3,
            bill_status = coalesce($4, bill_status),
            updated_by = $5,
            updated_at = now()
        where id = $1
          and company_id = $2
        returning
          id,
          employee_name as employee,
          purpose,
          category,
          amount,
          claim_status as status,
          coalesce(bill_status, '') as bill_status
      `,
      [id, companyId, status, billStatus, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "CLAIM_NOT_FOUND" });
    return res.json({ ok: true, claim: rows[0] });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/expenses/:id/receipt", requireScreenAction("expenses", "can_view"), async (req, res, next) => {
  try {
    const fs = require("fs");
    const companyId = requireResolvedCompanyId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const { rows } = await pool.query(
      `
        select a.file_path, a.mime_type, a.file_name
        from hr_expense_claims c
        join attachments a on a.id = c.receipt_attachment_id
        where c.id = $1
          and c.company_id = $2
          and c.receipt_attachment_id is not null
        limit 1
      `,
      [id, companyId]
    );
    const row = rows[0];
    if (!row?.file_path || !fs.existsSync(row.file_path)) {
      return res.status(404).json({ ok: false, error: "RECEIPT_NOT_FOUND" });
    }
    res.setHeader("Content-Type", row.mime_type || "image/jpeg");
    res.setHeader("Content-Disposition", `inline; filename="${String(row.file_name || "receipt.jpg").replace(/"/g, "")}"`);
    return fs.createReadStream(row.file_path).pipe(res);
  } catch (err) {
    return next(err);
  }
});

router.get("/planner", requireScreenAction("activity_planner", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const { rows } = await pool.query(
      `
        select
          id,
          title,
          owner_name as owner,
          coalesce(department_name, 'HR') as department,
          due_date as due,
          activity_stage as stage,
          priority
        from hr_planner_activities
        where company_id = $1
        order by due_date asc, updated_at desc, id desc
        limit 300
      `,
      [companyId]
    );
    return res.json({ ok: true, activities: rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/planner", requireScreenAction("activity_planner", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const title = cleanText(req.body?.title);
    const owner = cleanText(req.body?.owner);
    const department = cleanText(req.body?.department) || "HR";
    const due = cleanDate(req.body?.due);
    const priority = normalizePriority(req.body?.priority);
    if (!title || !owner || !due) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    const resolved = await resolveUserContext(client, companyId, owner);
    const { rows } = await client.query(
      `
        insert into hr_planner_activities (
          company_id,
          owner_user_id,
          owner_name,
          title,
          department_name,
          due_date,
          activity_stage,
          priority,
          created_by,
          updated_by
        )
        values ($1,$2,$3,$4,$5,$6,'planned',$7,$8,$8)
        returning
          id,
          title,
          owner_name as owner,
          coalesce(department_name, 'HR') as department,
          due_date as due,
          activity_stage as stage,
          priority
      `,
      [companyId, resolved.userId, resolved.displayName || owner, title, department, due, priority, req.user.id]
    );
    return res.status(201).json({ ok: true, activity: rows[0] });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.patch("/planner/:id", requireScreenAction("activity_planner", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const stage = normalizePlannerStage(req.body?.stage);
    const { rows } = await client.query(
      `
        update hr_planner_activities
        set activity_stage = $3,
            updated_by = $4,
            updated_at = now()
        where id = $1
          and company_id = $2
        returning
          id,
          title,
          owner_name as owner,
          coalesce(department_name, 'HR') as department,
          due_date as due,
          activity_stage as stage,
          priority
      `,
      [id, companyId, stage, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "ACTIVITY_NOT_FOUND" });
    return res.json({ ok: true, activity: rows[0] });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/events", requireScreenAction("events", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const { rows } = await pool.query(
      `
        select
          id,
          title,
          event_type as type,
          event_date as date,
          venue,
          event_status as status,
          participants_count as participants,
          coalesce(note, '') as note
        from hr_events
        where company_id = $1
        order by event_date asc, updated_at desc, id desc
        limit 200
      `,
      [companyId]
    );
    return res.json({ ok: true, events: rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/events", requireScreenAction("events", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const title = cleanText(req.body?.title);
    const type = cleanText(req.body?.type) || "Company event";
    const date = cleanDate(req.body?.date);
    const venue = cleanText(req.body?.venue);
    if (!title || !date || !venue) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    const { rows } = await client.query(
      `
        insert into hr_events (
          company_id,
          title,
          event_type,
          event_date,
          venue,
          event_status,
          participants_count,
          note,
          created_by,
          updated_by
        )
        values ($1,$2,$3,$4,$5,'registration_open',0,'Registration just opened',$6,$6)
        returning
          id,
          title,
          event_type as type,
          event_date as date,
          venue,
          event_status as status,
          participants_count as participants,
          coalesce(note, '') as note
      `,
      [companyId, title, type, date, venue, req.user.id]
    );
    return res.status(201).json({ ok: true, event: rows[0] });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.patch("/events/:id", requireScreenAction("events", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const status = normalizeEventStatus(req.body?.status);
    const participantDelta = Number(req.body?.participant_delta || 0);
    const note = cleanText(req.body?.note);
    const { rows } = await client.query(
      `
        update hr_events
        set event_status = $3,
            participants_count = greatest(0, participants_count + $4),
            note = coalesce($5, note),
            updated_by = $6,
            updated_at = now()
        where id = $1
          and company_id = $2
        returning
          id,
          title,
          event_type as type,
          event_date as date,
          venue,
          event_status as status,
          participants_count as participants,
          coalesce(note, '') as note
      `,
      [id, companyId, status, Number.isFinite(participantDelta) ? participantDelta : 0, note, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "EVENT_NOT_FOUND" });
    return res.json({ ok: true, event: rows[0] });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/leave", requireScreenAction("leave", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const [leaveRes, holidayRes] = await Promise.all([
      pool.query(
        `
          select
            id,
            employee_name as employee,
            leave_type,
            start_date,
            end_date,
            total_days,
            leave_status as status,
            coalesce(reason, '') as reason
          from hr_leave_requests
          where company_id = $1
          order by start_date desc, updated_at desc, id desc
          limit 200
        `,
        [companyId]
      ),
      pool.query(
        `
          select
            id,
            holiday_name,
            holiday_date,
            holiday_type,
            coalesce(note, '') as note
          from hr_holidays
          where company_id = $1
          order by holiday_date asc, id asc
          limit 100
        `,
        [companyId]
      ),
    ]);
    return res.json({ ok: true, requests: leaveRes.rows, holidays: holidayRes.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/leave", requireScreenAction("leave", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const employee = cleanText(req.body?.employee);
    const leaveType = cleanText(req.body?.leave_type) || "Casual";
    const startDate = cleanDate(req.body?.start_date);
    const endDate = cleanDate(req.body?.end_date) || startDate;
    const reason = cleanText(req.body?.reason);
    const totalDays = Number(req.body?.total_days || 1);
    if (!employee || !startDate || !endDate || totalDays <= 0) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    const resolved = await resolveUserContext(client, companyId, employee);
    const { rows } = await client.query(
      `
        insert into hr_leave_requests (
          company_id,
          employee_user_id,
          employee_name,
          leave_type,
          start_date,
          end_date,
          total_days,
          leave_status,
          reason,
          created_by,
          updated_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$9)
        returning
          id,
          employee_name as employee,
          leave_type,
          start_date,
          end_date,
          total_days,
          leave_status as status,
          coalesce(reason, '') as reason
      `,
      [companyId, resolved.userId, resolved.displayName || employee, leaveType, startDate, endDate, totalDays, reason, req.user.id]
    );
    if (rows[0]?.id) {
      notifyLeaveApprovalNeeded({
        leaveId: rows[0].id,
        employeeUserId: resolved.userId,
        employeeName: rows[0].employee,
        leaveType: rows[0].leave_type,
        startDate: rows[0].start_date,
        endDate: rows[0].end_date,
        companyId,
        actorUserId: req.user.id,
      }).catch(() => {});
    }
    return res.status(201).json({ ok: true, request: rows[0] });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.patch("/leave/:id", requireScreenAction("leave", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const status = cleanText(req.body?.status) || "pending";
    if (status !== "pending" && !ensureHrApprovalAccess(req, res, "leave", "You do not have approval rights for leave decisions.")) return;
    const { rows } = await client.query(
      `
        update hr_leave_requests
        set leave_status = $3,
            updated_by = $4,
            updated_at = now()
        where id = $1
          and company_id = $2
        returning
          id,
          employee_name as employee,
          leave_type,
          start_date,
          end_date,
          total_days,
          leave_status as status,
          coalesce(reason, '') as reason
      `,
      [id, companyId, status, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "LEAVE_NOT_FOUND" });
    return res.json({ ok: true, request: rows[0] });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/holidays", requireScreenAction("holidays", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const { rows } = await pool.query(
      `
        select
          id,
          holiday_name,
          holiday_date,
          holiday_type,
          coalesce(note, '') as note
        from hr_holidays
        where company_id = $1
        order by holiday_date asc, id asc
        limit 200
      `,
      [companyId]
    );
    return res.json({ ok: true, holidays: rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/holidays", requireScreenAction("holidays", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const holidayName = cleanText(req.body?.holiday_name);
    const holidayDate = cleanDate(req.body?.holiday_date);
    const holidayType = cleanText(req.body?.holiday_type) || "Company holiday";
    const note = cleanText(req.body?.note);
    if (!holidayName || !holidayDate) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    const { rows } = await client.query(
      `
        insert into hr_holidays (
          company_id,
          holiday_name,
          holiday_date,
          holiday_type,
          note,
          created_by,
          updated_by
        )
        values ($1,$2,$3,$4,$5,$6,$6)
        on conflict (company_id, holiday_date, holiday_name)
        do update set
          holiday_type = excluded.holiday_type,
          note = excluded.note,
          updated_by = excluded.updated_by,
          updated_at = now()
        returning
          id,
          holiday_name,
          holiday_date,
          holiday_type,
          coalesce(note, '') as note
      `,
      [companyId, holidayName, holidayDate, holidayType, note, req.user.id]
    );
    return res.status(201).json({ ok: true, holiday: rows[0] });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/salary", requireScreenAction("salary", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const [profilesRes, slipsRes] = await Promise.all([
      pool.query(
        `
          select
            id,
            employee_name as employee,
            coalesce(department_name, 'General') as department,
            monthly_ctc,
            basic_amount,
            hra_amount,
            special_allowance,
            deductions_amount,
            net_salary,
            is_active
          from hr_salary_profiles
          where company_id = $1
          order by is_active desc, updated_at desc, id desc
          limit 200
        `,
        [companyId]
      ),
      pool.query(
        `
          select count(*)::int as generated_count
          from hr_salary_slips
          where company_id = $1
        `,
        [companyId]
      ),
    ]);
    return res.json({ ok: true, profiles: profilesRes.rows, generated_count: slipsRes.rows[0]?.generated_count || 0 });
  } catch (err) {
    return next(err);
  }
});

router.post("/salary", requireScreenAction("salary", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const employee = cleanText(req.body?.employee);
    const department = cleanText(req.body?.department) || "General";
    const monthlyCtc = cleanAmount(req.body?.monthly_ctc);
    const basic = cleanAmount(req.body?.basic_amount);
    const hra = cleanAmount(req.body?.hra_amount);
    const special = cleanAmount(req.body?.special_allowance);
    const deductions = cleanAmount(req.body?.deductions_amount);
    const net = cleanAmount(req.body?.net_salary || basic + hra + special - deductions);
    if (!employee || monthlyCtc <= 0) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    const resolved = await resolveUserContext(client, companyId, employee);
    const { rows } = await client.query(
      `
        insert into hr_salary_profiles (
          company_id,
          employee_user_id,
          employee_name,
          department_name,
          monthly_ctc,
          basic_amount,
          hra_amount,
          special_allowance,
          deductions_amount,
          net_salary,
          is_active,
          created_by,
          updated_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$11)
        returning
          id,
          employee_name as employee,
          coalesce(department_name, 'General') as department,
          monthly_ctc,
          basic_amount,
          hra_amount,
          special_allowance,
          deductions_amount,
          net_salary,
          is_active
      `,
      [companyId, resolved.userId, resolved.displayName || employee, resolved.departmentName || department, monthlyCtc, basic, hra, special, deductions, net, req.user.id]
    );
    return res.status(201).json({ ok: true, profile: rows[0] });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/salary/run", requireScreenAction("salary", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const payrollMonth = cleanDate(req.body?.payroll_month);
    if (!payrollMonth) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    await client.query("begin");
    const profileRes = await client.query(
      `
        select
          id,
          employee_user_id,
          employee_name,
          basic_amount,
          hra_amount,
          special_allowance,
          deductions_amount,
          net_salary
        from hr_salary_profiles
        where company_id = $1
          and is_active = true
      `,
      [companyId]
    );
    let generated = 0;
    for (const profile of profileRes.rows) {
      await client.query(
        `
          insert into hr_salary_slips (
            company_id,
            salary_profile_id,
            employee_user_id,
            employee_name,
            payroll_month,
            basic_amount,
            hra_amount,
            special_allowance,
            deductions_amount,
            net_salary,
            slip_status,
            created_by,
            updated_by
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'generated',$11,$11)
          on conflict (company_id, salary_profile_id, payroll_month)
          do update set
            basic_amount = excluded.basic_amount,
            hra_amount = excluded.hra_amount,
            special_allowance = excluded.special_allowance,
            deductions_amount = excluded.deductions_amount,
            net_salary = excluded.net_salary,
            updated_by = excluded.updated_by,
            updated_at = now()
        `,
        [
          companyId,
          profile.id,
          profile.employee_user_id,
          profile.employee_name,
          payrollMonth,
          profile.basic_amount,
          profile.hra_amount,
          profile.special_allowance,
          profile.deductions_amount,
          profile.net_salary,
          req.user.id,
        ]
      );
      generated += 1;
    }
    await client.query("commit");
    return res.json({ ok: true, generated_count: generated });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/salary-slips", requireScreenAction("salary_slips", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const { rows } = await pool.query(
      `
        select
          id,
          employee_name as employee,
          payroll_month,
          basic_amount,
          hra_amount,
          special_allowance,
          deductions_amount,
          net_salary,
          slip_status as status,
          paid_on
        from hr_salary_slips
        where company_id = $1
        order by payroll_month desc, updated_at desc, id desc
        limit 300
      `,
      [companyId]
    );
    return res.json({ ok: true, slips: rows });
  } catch (err) {
    return next(err);
  }
});

router.patch("/salary-slips/:id", requireScreenAction("salary_slips", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const status = cleanText(req.body?.status) || "generated";
    if (status === "paid" && !ensureHrApprovalAccess(req, res, "salary_slips", "You do not have approval rights to close salary payouts.")) return;
    const paidOn = cleanDate(req.body?.paid_on) || (status === "paid" ? new Date().toISOString().slice(0, 10) : null);
    const { rows } = await client.query(
      `
        update hr_salary_slips
        set slip_status = $3,
            paid_on = case when $3 = 'paid' then $4 else paid_on end,
            updated_by = $5,
            updated_at = now()
        where id = $1
          and company_id = $2
        returning
          id,
          employee_name as employee,
          payroll_month,
          basic_amount,
          hra_amount,
          special_allowance,
          deductions_amount,
          net_salary,
          slip_status as status,
          paid_on
      `,
      [id, companyId, status, paidOn, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "SALARY_SLIP_NOT_FOUND" });
    return res.json({ ok: true, slip: rows[0] });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
