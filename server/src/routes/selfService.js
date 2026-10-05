const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const { pool } = require("../db/pool");
const { hasScreenAction, requireScreenAction } = require("../auth/authorization");
const { createOwnedAttachment } = require("../services/attachmentOwnership");
const { requireResolvedCompanyId } = require("../services/companyContext");
const { notifyExpenseApprovalNeeded } = require("../services/notifications");

const router = express.Router();

const MAX_RECEIPT_BYTES = 1.5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RECEIPT_BYTES },
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function cleanText(value, max = 500) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, max);
}

function cleanAmount(value) {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : 0;
}

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function nowTimeString() {
  return new Date().toISOString().slice(11, 19);
}

function displayName(user) {
  return cleanText(user?.full_name, 160) || cleanText(user?.email, 160) || "Employee";
}

function ensureExpenseReceiptDir() {
  const dir = path.resolve(__dirname, "..", "..", "storage", "expenses", "receipts");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isReceiptImage(file) {
  if (!file) return false;
  const name = typeof file.originalname === "string" ? file.originalname.toLowerCase() : "";
  const mime = typeof file.mimetype === "string" ? file.mimetype.toLowerCase() : "";
  if (mime.startsWith("image/")) return true;
  if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".webp")) return true;
  if (name.endsWith(".heic") || name.endsWith(".heif") || mime.includes("heic") || mime.includes("heif")) return true;
  return false;
}

function mapDutyRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    attendance_date: row.attendance_date,
    status: row.attendance_status,
    in_time: row.in_time_fmt || null,
    out_time: row.out_time_fmt || null,
    note: row.note || "",
    source_channel: row.source_channel || "self_service",
  };
}

function mapClaimRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    purpose: row.purpose,
    category: row.category,
    amount: Number(row.amount || 0),
    status: row.claim_status,
    bill_status: row.bill_status || "",
    reference_no: row.reference_no || "",
    job_card_id: row.job_card_id || null,
    service_case_id: row.service_case_id || null,
    receipt_attachment_id: row.receipt_attachment_id || null,
    has_receipt: Boolean(row.receipt_attachment_id),
    source_channel: row.source_channel || "self_service",
    created_at: row.created_at,
  };
}

router.use(requireAuth);

router.get("/bootstrap", requireScreenAction("my_duty_expenses", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
    const userId = asInt(req.user.id);
    const today = todayDateString();

    const dutyRes = await client.query(
      `
        select
          id,
          attendance_date,
          attendance_status,
          to_char(in_time, 'HH24:MI') as in_time_fmt,
          to_char(out_time, 'HH24:MI') as out_time_fmt,
          coalesce(note, '') as note,
          source_channel
        from hr_attendance_records
        where company_id = $1
          and employee_user_id = $2
          and attendance_date = $3::date
        order by id desc
        limit 1
      `,
      [companyId, userId, today]
    );

    const claimsRes = await client.query(
      `
        select
          id,
          purpose,
          category,
          amount,
          claim_status,
          bill_status,
          reference_no,
          job_card_id,
          service_case_id,
          receipt_attachment_id,
          source_channel,
          created_at
        from hr_expense_claims
        where company_id = $1
          and employee_user_id = $2
        order by created_at desc, id desc
        limit 40
      `,
      [companyId, userId]
    );

    let jobCards = [];
    let serviceCases = [];

    if (hasScreenAction(req, "job_cards", "can_view")) {
      const jc = await client.query(
        `
          select
            jc.id,
            jc.job_card_number,
            jc.job_status,
            coalesce(c.customer_name, soc.customer_name, '') as customer_name
          from job_cards jc
          left join service_warranty_cases swc on swc.id = jc.service_warranty_case_id
          left join customers c on c.id = swc.customer_id
          left join sales_orders so on so.id = jc.sales_order_id
          left join customers soc on soc.id = so.customer_id
          where jc.company_id = $1
          order by jc.updated_at desc nulls last, jc.id desc
          limit 40
        `,
        [companyId]
      );
      jobCards = jc.rows;
    }

    if (hasScreenAction(req, "service_warranty", "can_view")) {
      const sc = await client.query(
        `
          select
            swc.id,
            swc.case_number,
            swc.case_status,
            coalesce(c.customer_name, '') as customer_name
          from service_warranty_cases swc
          left join customers c on c.id = swc.customer_id
          order by swc.updated_at desc nulls last, swc.id desc
          limit 40
        `
      );
      serviceCases = sc.rows;
    }

    return res.json({
      ok: true,
      me: {
        id: userId,
        name: displayName(req.user),
        email: req.user.email || "",
        department: req.user.department_key || "",
      },
      today,
      duty: mapDutyRow(dutyRes.rows[0] || null),
      claims: claimsRes.rows.map(mapClaimRow),
      job_cards: jobCards,
      service_cases: serviceCases,
    });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/duty", requireScreenAction("my_duty_expenses", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
    const userId = asInt(req.user.id);
    const today = cleanText(req.body?.attendance_date, 10) || todayDateString();
    const intendedIn = cleanText(req.body?.intended_in_time, 12);
    const inTime = intendedIn && /^\d{2}:\d{2}(:\d{2})?$/.test(intendedIn)
      ? intendedIn.length === 5
        ? `${intendedIn}:00`
        : intendedIn
      : nowTimeString();
    const note = cleanText(req.body?.note, 500);
    const name = displayName(req.user);
    const department = cleanText(req.user.department_key, 80) || "General";

    const existing = await client.query(
      `
        select
          id,
          attendance_date,
          attendance_status,
          to_char(in_time, 'HH24:MI') as in_time_fmt,
          to_char(out_time, 'HH24:MI') as out_time_fmt,
          coalesce(note, '') as note,
          source_channel
        from hr_attendance_records
        where company_id = $1
          and employee_user_id = $2
          and attendance_date = $3::date
        limit 1
      `,
      [companyId, userId, today]
    );

    if (existing.rows[0]) {
      return res.json({ ok: true, duty: mapDutyRow(existing.rows[0]), already_started: true });
    }

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
          in_time,
          note,
          source_channel,
          created_by,
          updated_by
        )
        values ($1,$2,$3,$4,'General','present',$5::date,$6::time,$7,'self_service',$8,$8)
        returning
          id,
          attendance_date,
          attendance_status,
          to_char(in_time, 'HH24:MI') as in_time_fmt,
          to_char(out_time, 'HH24:MI') as out_time_fmt,
          coalesce(note, '') as note,
          source_channel
      `,
      [companyId, userId, name, department, today, inTime, note, userId]
    );

    return res.status(201).json({ ok: true, duty: mapDutyRow(rows[0]), already_started: false });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({ ok: false, error: "DUTY_ALREADY_STARTED" });
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.patch("/duty/:id", requireScreenAction("my_duty_expenses", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
    const userId = asInt(req.user.id);
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const intendedOut = cleanText(req.body?.intended_out_time, 12);
    const outTime = intendedOut && /^\d{2}:\d{2}(:\d{2})?$/.test(intendedOut)
      ? intendedOut.length === 5
        ? `${intendedOut}:00`
        : intendedOut
      : nowTimeString();
    const note = cleanText(req.body?.note, 500);

    const { rows } = await client.query(
      `
        update hr_attendance_records
        set out_time = $4::time,
            note = coalesce($5, note),
            updated_by = $6,
            updated_at = now()
        where id = $1
          and company_id = $2
          and employee_user_id = $3
        returning
          id,
          attendance_date,
          attendance_status,
          to_char(in_time, 'HH24:MI') as in_time_fmt,
          to_char(out_time, 'HH24:MI') as out_time_fmt,
          coalesce(note, '') as note,
          source_channel
      `,
      [id, companyId, userId, outTime, note, userId]
    );

    if (!rows[0]) return res.status(404).json({ ok: false, error: "DUTY_NOT_FOUND" });
    return res.json({ ok: true, duty: mapDutyRow(rows[0]) });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post(
  "/expenses",
  requireScreenAction("my_duty_expenses", "can_create"),
  (req, res, next) => {
    upload.single("receipt")(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ ok: false, error: "RECEIPT_TOO_LARGE" });
        }
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
      const userId = asInt(req.user.id);
      const purpose = cleanText(req.body?.purpose, 500);
      const category = cleanText(req.body?.category, 80) || "Travel";
      const amount = cleanAmount(req.body?.amount);
      const referenceNo = cleanText(req.body?.reference_no, 120);
      const jobCardId = asInt(req.body?.job_card_id);
      const serviceCaseId = asInt(req.body?.service_case_id);
      const file = req.file;

      if (!purpose || amount <= 0) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
      if (!isReceiptImage(file)) return res.status(400).json({ ok: false, error: "RECEIPT_REQUIRED" });
      if ((file.size || file.buffer?.length || 0) > MAX_RECEIPT_BYTES) {
        return res.status(400).json({ ok: false, error: "RECEIPT_TOO_LARGE" });
      }

      try {
        const policyRes = await client.query(
          `
            select daily_cap, claim_cap
            from expense_policy_limits
            where company_id = $1
              and lower(category) = lower($2)
              and is_active = true
            limit 1
          `,
          [companyId, category]
        );
        const policy = policyRes.rows[0];
        if (policy) {
          if (policy.claim_cap != null && amount > Number(policy.claim_cap) + 0.0001) {
            return res.status(400).json({
              ok: false,
              error: "EXPENSE_CLAIM_CAP_EXCEEDED",
              detail: `Claim amount exceeds policy cap of ${Number(policy.claim_cap).toFixed(2)} for ${category}.`,
              claim_cap: Number(policy.claim_cap),
            });
          }
          if (policy.daily_cap != null) {
            const daySum = await client.query(
              `
                select coalesce(sum(amount), 0) as day_total
                from hr_expense_claims
                where company_id = $1
                  and employee_user_id = $2
                  and lower(category) = lower($3)
                  and claim_status <> 'returned'
                  and created_at::date = current_date
              `,
              [companyId, userId, category]
            );
            const nextTotal = Number(daySum.rows[0]?.day_total || 0) + amount;
            if (nextTotal > Number(policy.daily_cap) + 0.0001) {
              return res.status(400).json({
                ok: false,
                error: "EXPENSE_DAILY_CAP_EXCEEDED",
                detail: `Daily cap of ${Number(policy.daily_cap).toFixed(2)} for ${category} would be exceeded.`,
                daily_cap: Number(policy.daily_cap),
              });
            }
          }
        }
      } catch {
        // Policy table may be absent until migration 151.
      }

      await client.query("begin");

      const dir = ensureExpenseReceiptDir();
      const stamp = Date.now();
      const storedFileName = `expense_${userId}_${stamp}.jpg`;
      const absFilePath = path.join(dir, storedFileName);
      fs.writeFileSync(absFilePath, file.buffer);

      const attach = await createOwnedAttachment(client, {
        fileName: file.originalname || storedFileName,
        filePath: absFilePath,
        mimeType: file.mimetype || "image/jpeg",
        fileSizeBytes: file.size || file.buffer.length || 0,
        uploadedBy: userId,
        companyId,
        ownerType: "expense_receipt",
        ownerId: null,
        visibilityScope: "company",
      });

      if (!attach?.id) {
        await client.query("rollback");
        return res.status(500).json({ ok: false, error: "ATTACHMENT_FAILED" });
      }

      const name = displayName(req.user);
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
            receipt_attachment_id,
            job_card_id,
            service_case_id,
            reference_no,
            source_channel,
            created_by,
            updated_by
          )
          values (
            $1,$2,$3,$4,$5,$6,
            'manager_pending','Waiting for manager approval',
            $7,$8,$9,$10,'self_service',$11,$11
          )
          returning
            id,
            purpose,
            category,
            amount,
            claim_status,
            bill_status,
            reference_no,
            job_card_id,
            service_case_id,
            receipt_attachment_id,
            source_channel,
            created_at
        `,
        [
          companyId,
          userId,
          name,
          purpose,
          category,
          amount,
          attach.id,
          jobCardId,
          serviceCaseId,
          referenceNo,
          userId,
        ]
      );

      await client.query(
        `
          update attachments
          set owner_id = $2
          where id = $1
        `,
        [attach.id, rows[0].id]
      );

      await client.query("commit");

      if (rows[0]?.id) {
        notifyExpenseApprovalNeeded({
          claimId: rows[0].id,
          employeeUserId: userId,
          employeeName: name,
          purpose: rows[0].purpose,
          amount: rows[0].amount,
          companyId,
          actorUserId: userId,
        }).catch(() => {});
      }

      return res.status(201).json({ ok: true, claim: mapClaimRow(rows[0]) });
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

router.get("/expenses/:id/receipt", requireScreenAction("my_duty_expenses", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
    const userId = asInt(req.user.id);
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const isHr = hasScreenAction(req, "expenses", "can_view") || req.user.group_name === "SuperAdmin";
    const { rows } = await pool.query(
      `
        select
          c.id,
          c.employee_user_id,
          c.company_id,
          a.file_path,
          a.mime_type,
          a.file_name
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
    if (!row) return res.status(404).json({ ok: false, error: "RECEIPT_NOT_FOUND" });
    if (!isHr && Number(row.employee_user_id) !== userId) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!row.file_path || !fs.existsSync(row.file_path)) {
      return res.status(404).json({ ok: false, error: "FILE_MISSING" });
    }

    res.setHeader("Content-Type", row.mime_type || "image/jpeg");
    res.setHeader("Content-Disposition", `inline; filename="${String(row.file_name || "receipt.jpg").replace(/"/g, "")}"`);
    return fs.createReadStream(row.file_path).pipe(res);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
