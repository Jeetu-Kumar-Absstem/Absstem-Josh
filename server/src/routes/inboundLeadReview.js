const express = require("express");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { getActiveCompanyId } = require("../services/companyContext");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

router.use(requireAuth);
router.use(requireScreenAction("inbound_lead_review", "can_view"));

router.get("/", requireScreenAction("leads", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const status = String(req.query.status || "pending").trim().toLowerCase();
    const q = String(req.query.q || "").trim().toLowerCase();

    const params = [companyId];
    const where = [`coalesce(e.company_id, m.company_id) = $1`];
    if (status && status !== "all") {
      params.push(status);
      where.push(`e.review_status = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(
        `(lower(coalesce(e.from_email::text, '')) like $${params.length}
          or lower(coalesce(e.subject, '')) like $${params.length}
          or lower(coalesce(e.body_preview, '')) like $${params.length}
          or lower(coalesce(e.parse_company_name, '')) like $${params.length})`
      );
    }

    const { rows } = await pool.query(
      `
        select
          e.id,
          e.subject,
          e.from_email,
          e.from_name,
          e.body_preview,
          e.parse_company_name,
          e.parse_contact_name,
          e.parse_phone,
          e.review_status,
          e.received_at,
          e.converted_lead_id,
          e.matched_lead_id,
          e.reviewed_at,
          m.mailbox_key,
          m.mailbox_email,
          cl.lead_number as converted_lead_number,
          ml.lead_number as matched_lead_number
        from inbound_lead_emails e
        join inbound_mailboxes m on m.id = e.mailbox_id
        left join leads cl on cl.id = e.converted_lead_id
        left join leads ml on ml.id = e.matched_lead_id
        where ${where.join(" and ")}
        order by
          case when e.review_status = 'pending' then 0 else 1 end,
          e.received_at desc nulls last,
          e.id desc
        limit 150
      `,
      params
    );

    const summaryRes = await pool.query(
      `
        select e.review_status, count(*)::int as row_count
        from inbound_lead_emails e
        join inbound_mailboxes m on m.id = e.mailbox_id
        where coalesce(e.company_id, m.company_id) = $1
        group by e.review_status
      `,
      [companyId]
    );
    const summary = { pending: 0, converted: 0, linked_existing: 0, ignored: 0 };
    for (const row of summaryRes.rows) {
      summary[row.review_status] = Number(row.row_count || 0);
    }

    return res.json({ ok: true, items: rows, summary });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/convert", requireScreenAction("leads", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const emailRes = await client.query(
      `
        select e.*, m.company_id as mailbox_company_id
        from inbound_lead_emails e
        join inbound_mailboxes m on m.id = e.mailbox_id
        where e.id = $1
        limit 1
        for update of e
      `,
      [id]
    );
    const email = emailRes.rows[0] || null;
    if (!email) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    const emailCompanyId = Number(email.company_id || email.mailbox_company_id || 0);
    if (emailCompanyId !== Number(companyId)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (email.review_status !== "pending") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "NOT_PENDING" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const overrideCompany =
      typeof body.company_name === "string" && body.company_name.trim() ? body.company_name.trim() : null;
    const overrideContact =
      typeof body.contact_name === "string" && body.contact_name.trim() ? body.contact_name.trim() : null;
    const overridePhone =
      typeof body.phone === "string" && body.phone.trim() ? body.phone.trim() : null;
    const overrideEmail =
      typeof body.email === "string" && body.email.trim() ? body.email.trim().toLowerCase() : null;
    const overrideNeed =
      typeof body.need_summary === "string" && body.need_summary.trim() ? body.need_summary.trim() : null;

    if (overrideCompany || overrideContact || overridePhone) {
      await client.query(
        `
          update inbound_lead_emails
          set
            parse_company_name = coalesce($2, parse_company_name),
            parse_contact_name = coalesce($3, parse_contact_name),
            parse_phone = coalesce($4, parse_phone),
            updated_at = now()
          where id = $1
        `,
        [id, overrideCompany, overrideContact, overridePhone]
      );
      if (overrideCompany) email.parse_company_name = overrideCompany;
      if (overrideContact) email.parse_contact_name = overrideContact;
      if (overridePhone) email.parse_phone = overridePhone;
    }

    const companyName =
      overrideCompany ||
      (typeof email.parse_company_name === "string" && email.parse_company_name.trim()) ||
      (typeof email.from_name === "string" && email.from_name.trim()) ||
      (typeof email.subject === "string" && email.subject.trim()) ||
      "Inbound lead";
    const sourceRes = await client.query(
      `select id from lead_sources where source_code = 'EMAIL_INBOUND' and is_active = true limit 1`
    );
    const leadSourceId = sourceRes.rows[0]?.id || null;
    const numRes = await client.query(`select next_document_number('L') as lead_number`);
    const leadNumber = numRes.rows[0]?.lead_number;
    if (!leadNumber) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "NUMBERING_FAILED" });
    }
    const leadRes = await client.query(
      `
        insert into leads (lead_number, company_id, company_name, lead_source_id, status, priority, created_by)
        values ($1, $2, $3, $4, 'new', 'medium', $5)
        returning id, lead_number
      `,
      [leadNumber, companyId, companyName.slice(0, 200), leadSourceId, req.user.id]
    );
    const leadId = leadRes.rows[0]?.id;
    const contactName =
      overrideContact ||
      (typeof email.parse_contact_name === "string" && email.parse_contact_name.trim()) ||
      (typeof email.from_name === "string" && email.from_name.trim()) ||
      "Inbound contact";
    const contactEmail =
      overrideEmail || (typeof email.from_email === "string" ? String(email.from_email) : null);
    const contactPhone =
      overridePhone ||
      (typeof email.parse_phone === "string" && email.parse_phone.trim() ? email.parse_phone.trim() : null);
    await client.query(
      `
        insert into lead_contacts (lead_id, full_name, email, phone, is_primary)
        values ($1, $2, $3, $4, true)
      `,
      [leadId, contactName.slice(0, 160), contactEmail, contactPhone]
    );
    const activityNotes = [
      email.subject || `Inbound email #${id}`,
      overrideNeed ? `Need: ${overrideNeed}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    await client.query(
      `
        insert into lead_activities (lead_id, activity_type, subject, notes, created_by)
        values ($1, 'note', 'Converted from inbound email', $2, $3)
      `,
      [leadId, activityNotes, req.user.id]
    );
    await client.query(
      `
        update inbound_lead_emails
        set
          review_status = 'converted',
          converted_lead_id = $2,
          reviewed_by = $3,
          reviewed_at = now()
        where id = $1
      `,
      [id, leadId, req.user.id]
    );
    await client.query("commit");
    return res.json({ ok: true, lead_id: leadId, lead_number: leadRes.rows[0]?.lead_number || null });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/link", requireScreenAction("leads", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const leadId = Number(req.body?.lead_id);
    if (!Number.isFinite(id) || !Number.isFinite(leadId)) {
      return res.status(400).json({ ok: false, error: "LEAD_ID_REQUIRED" });
    }
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const emailRes = await client.query(
      `
        select e.*, m.company_id as mailbox_company_id
        from inbound_lead_emails e
        join inbound_mailboxes m on m.id = e.mailbox_id
        where e.id = $1
        limit 1
        for update of e
      `,
      [id]
    );
    const email = emailRes.rows[0] || null;
    if (!email) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    const emailCompanyId = Number(email.company_id || email.mailbox_company_id || 0);
    if (emailCompanyId !== Number(companyId)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (email.review_status !== "pending") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "NOT_PENDING" });
    }

    const leadRes = await client.query(
      `select id from leads where id = $1 and company_id = $2 limit 1`,
      [leadId, companyId]
    );
    if (!leadRes.rows[0]) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "LEAD_NOT_FOUND" });
    }

    await client.query(
      `
        update inbound_lead_emails
        set
          review_status = 'linked_existing',
          matched_lead_id = $2,
          reviewed_by = $3,
          reviewed_at = now()
        where id = $1
      `,
      [id, leadId, req.user.id]
    );
    await client.query("commit");
    return res.json({ ok: true, lead_id: leadId });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/ignore", requireScreenAction("leads", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : "";

    await client.query("begin");
    const emailRes = await client.query(
      `
        select e.*, m.company_id as mailbox_company_id
        from inbound_lead_emails e
        join inbound_mailboxes m on m.id = e.mailbox_id
        where e.id = $1
        limit 1
        for update of e
      `,
      [id]
    );
    const email = emailRes.rows[0] || null;
    if (!email) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    const emailCompanyId = Number(email.company_id || email.mailbox_company_id || 0);
    if (emailCompanyId !== Number(companyId)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (email.review_status !== "pending") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "NOT_PENDING" });
    }

    await client.query(
      `
        update inbound_lead_emails
        set
          review_status = 'ignored',
          review_notes = $2,
          reviewed_by = $3,
          reviewed_at = now()
        where id = $1
      `,
      [id, notes || null, req.user.id]
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

/** Manual IMAP unread poll (queues to review — never auto-creates leads). */
router.post("/imap-poll", requireScreenAction("leads", "can_view"), async (req, res, next) => {
  try {
    const { pool } = require("../db/pool");
    const { processUnreadOnce, getImapConfig } = require("../services/imapInboundIngest");
    const cfg = getImapConfig();
    if (!cfg.enabled) {
      return res.status(400).json({ ok: false, error: "IMAP_INGEST_DISABLED" });
    }
    const result = await processUnreadOnce(pool, cfg);
    return res.json({ ok: true, result });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
