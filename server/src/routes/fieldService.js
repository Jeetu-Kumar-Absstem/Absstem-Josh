const express = require("express");
const { pool } = require("../db/pool");
const { requireScreenAction, hasScreenAction } = require("../auth/authorization");
const { canAccessCompanyContext, requireResolvedCompanyId } = require("../services/companyContext");
const {
  completeCommissioningTicket,
  emitCommissioningCompleted,
  getSiteReadinessForSalesOrder,
} = require("../services/commissioningGates");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function canViewSiteReadiness(req) {
  return (
    hasScreenAction(req, "field_service", "can_view") ||
    hasScreenAction(req, "sales_orders", "can_view") ||
    hasScreenAction(req, "dispatches", "can_view")
  );
}

function canEditSiteReadiness(req) {
  return (
    hasScreenAction(req, "field_service", "can_edit") ||
    hasScreenAction(req, "sales_orders", "can_edit") ||
    hasScreenAction(req, "dispatches", "can_edit")
  );
}

function canApproveSiteReadiness(req) {
  return (
    req.user?.group_name === "SuperAdmin" ||
    hasScreenAction(req, "field_service", "can_approve") ||
    hasScreenAction(req, "sales_orders", "can_approve") ||
    hasScreenAction(req, "dispatches", "can_approve")
  );
}

function requireSiteReadinessView(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (canViewSiteReadiness(req)) return next();
  return res.status(403).json({ ok: false, error: "FORBIDDEN" });
}

function requireSiteReadinessEdit(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (canEditSiteReadiness(req)) return next();
  return res.status(403).json({ ok: false, error: "FORBIDDEN" });
}

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function cleanText(value, max = 4000) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, max);
}

function toDateOnly(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  return text.slice(0, 10);
}

async function loadSalesOrder(client, salesOrderId) {
  const r = await client.query(
    `
      select so.id, so.company_id, so.customer_id, so.so_number, so.order_status,
             c.customer_name
      from sales_orders so
      join customers c on c.id = so.customer_id
      where so.id = $1
      limit 1
    `,
    [asInt(salesOrderId)]
  );
  return r.rows[0] || null;
}

router.use(requireAuth);

/** Capabilities / unlock listener health */
router.get("/capabilities", requireScreenAction("field_service", "can_view"), (_req, res) => {
  return res.json({
    ok: true,
    gates: {
      dispatch_requires_site_readiness_approved: true,
      warranty_starts_on_commissioning_signoff: true,
      commissioning_milestones_unlock_on_complete: true,
    },
  });
});

// ─── Site readiness ───────────────────────────────────────────────────────────

router.get(
  "/site-readiness",
  requireSiteReadinessView,
  async (req, res, next) => {
    try {
      const salesOrderId = asInt(req.query.sales_order_id);
      if (!salesOrderId) return res.status(400).json({ ok: false, error: "SALES_ORDER_ID_REQUIRED" });
      const order = await loadSalesOrder(pool, salesOrderId);
      if (!order) return res.status(404).json({ ok: false, error: "SALES_ORDER_NOT_FOUND" });
      if (!canAccessCompanyContext(req, order)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      const checklist = await getSiteReadinessForSalesOrder(pool, salesOrderId);
      return res.json({ ok: true, sales_order: order, checklist });
    } catch (err) {
      return next(err);
    }
  }
);

router.post(
  "/site-readiness",
  requireSiteReadinessEdit,
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const salesOrderId = asInt(req.body?.sales_order_id);
      if (!salesOrderId) return res.status(400).json({ ok: false, error: "SALES_ORDER_ID_REQUIRED" });

      await client.query("begin");
      const order = await loadSalesOrder(client, salesOrderId);
      if (!order) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "SALES_ORDER_NOT_FOUND" });
      }
      if (!canAccessCompanyContext(req, order)) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      }
      const companyId = requireResolvedCompanyId(req, order.company_id);
      if (!companyId) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
      }

      const existing = await getSiteReadinessForSalesOrder(client, salesOrderId);
      if (existing) {
        await client.query("rollback");
        return res.status(409).json({ ok: false, error: "CHECKLIST_EXISTS", checklist: existing });
      }

      const inserted = await client.query(
        `
          insert into site_readiness_checklists (
            company_id, sales_order_id, customer_id, status,
            electrical_ready, civil_ready, pneumatic_ready, created_by
          )
          values ($1,$2,$3,'Draft',$4,$5,$6,$7)
          returning *
        `,
        [
          companyId,
          salesOrderId,
          order.customer_id,
          Boolean(req.body?.electrical_ready),
          Boolean(req.body?.civil_ready),
          Boolean(req.body?.pneumatic_ready),
          req.user.id,
        ]
      );
      await client.query("commit");
      return res.status(201).json({ ok: true, checklist: inserted.rows[0] });
    } catch (err) {
      await client.query("rollback");
      return next(err);
    } finally {
      client.release();
    }
  }
);

router.patch(
  "/site-readiness/:id",
  requireSiteReadinessEdit,
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const id = asInt(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });

      await client.query("begin");
      const cur = await client.query(`select * from site_readiness_checklists where id = $1 for update`, [id]);
      const row = cur.rows[0];
      if (!row) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }
      if (!canAccessCompanyContext(req, row)) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      }
      if (String(row.status) === "Approved") {
        await client.query("rollback");
        return res.status(409).json({ ok: false, error: "ALREADY_APPROVED" });
      }

      const nextStatus = req.body?.status != null ? String(req.body.status).trim() : row.status;
      const allowed = new Set(["Draft", "Client_Submitted", "Approved", "Rejected"]);
      if (!allowed.has(nextStatus)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
      }

      if (nextStatus === "Approved") {
        if (!canApproveSiteReadiness(req)) {
          await client.query("rollback");
          return res.status(403).json({ ok: false, error: "APPROVE_FORBIDDEN" });
        }
        const electrical = req.body?.electrical_ready != null ? Boolean(req.body.electrical_ready) : row.electrical_ready;
        const civil = req.body?.civil_ready != null ? Boolean(req.body.civil_ready) : row.civil_ready;
        const pneumatic = req.body?.pneumatic_ready != null ? Boolean(req.body.pneumatic_ready) : row.pneumatic_ready;
        if (!electrical || !civil || !pneumatic) {
          await client.query("rollback");
          return res.status(409).json({
            ok: false,
            error: "READINESS_INCOMPLETE",
            detail: "electrical_ready, civil_ready, and pneumatic_ready must all be true before approval.",
          });
        }
      }

      const updated = await client.query(
        `
          update site_readiness_checklists
          set
            status = $2,
            electrical_ready = coalesce($3, electrical_ready),
            civil_ready = coalesce($4, civil_ready),
            pneumatic_ready = coalesce($5, pneumatic_ready),
            rejection_reason = case when $2 = 'Rejected' then coalesce($6, rejection_reason) else rejection_reason end,
            approved_by = case when $2 = 'Approved' then $7 else approved_by end,
            approved_at = case when $2 = 'Approved' then now() else approved_at end,
            updated_at = now()
          where id = $1
          returning *
        `,
        [
          id,
          nextStatus,
          req.body?.electrical_ready != null ? Boolean(req.body.electrical_ready) : null,
          req.body?.civil_ready != null ? Boolean(req.body.civil_ready) : null,
          req.body?.pneumatic_ready != null ? Boolean(req.body.pneumatic_ready) : null,
          cleanText(req.body?.rejection_reason, 2000),
          req.user.id,
        ]
      );
      await client.query("commit");
      return res.json({ ok: true, checklist: updated.rows[0] });
    } catch (err) {
      await client.query("rollback");
      return next(err);
    } finally {
      client.release();
    }
  }
);

// ─── Commissioning tickets ────────────────────────────────────────────────────

router.get("/engineers", requireScreenAction("field_service", "can_view"), async (req, res, next) => {
  try {
    const r = await pool.query(
      `
        select id, full_name, email, user_code
        from erp_users
        where is_active = true
        order by full_name nulls last, email
        limit 500
      `
    );
    return res.json({ ok: true, engineers: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.get(
  "/tickets",
  requireScreenAction("field_service", "can_view"),
  async (req, res, next) => {
    try {
      const companyId = requireResolvedCompanyId(req);
      const params = [];
      const where = [];
      if (companyId) {
        params.push(companyId);
        where.push(`ct.company_id = $${params.length}`);
      }
      if (req.query.sales_order_id) {
        params.push(asInt(req.query.sales_order_id));
        where.push(`ct.sales_order_id = $${params.length}`);
      }
      if (req.query.status) {
        params.push(String(req.query.status).trim());
        where.push(`ct.status = $${params.length}`);
      }
      if (req.query.mine === "1" || req.query.mine === "true") {
        params.push(req.user.id);
        where.push(`ct.assigned_engineer_id = $${params.length}`);
      }

      const r = await pool.query(
        `
          select ct.*, so.so_number, c.customer_name,
                 u.full_name as assigned_engineer_name
          from commissioning_tickets ct
          join sales_orders so on so.id = ct.sales_order_id
          join customers c on c.id = ct.customer_id
          left join erp_users u on u.id = ct.assigned_engineer_id
          ${where.length ? `where ${where.join(" and ")}` : ""}
          order by ct.scheduled_date nulls last, ct.id desc
          limit 200
        `,
        params
      );
      const tickets = r.rows.filter((row) => canAccessCompanyContext(req, row));
      return res.json({ ok: true, tickets });
    } catch (err) {
      return next(err);
    }
  }
);

router.post(
  "/tickets",
  requireScreenAction("field_service", "can_create"),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const salesOrderId = asInt(req.body?.sales_order_id);
      if (!salesOrderId) return res.status(400).json({ ok: false, error: "SALES_ORDER_ID_REQUIRED" });

      await client.query("begin");
      const order = await loadSalesOrder(client, salesOrderId);
      if (!order) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "SALES_ORDER_NOT_FOUND" });
      }
      if (!canAccessCompanyContext(req, order)) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      }
      const companyId = requireResolvedCompanyId(req, order.company_id);
      if (!companyId) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
      }

      const inserted = await client.query(
        `
          insert into commissioning_tickets (
            company_id, sales_order_id, customer_id, assigned_engineer_id,
            scheduled_date, status, piping_infrastructure_status, welding_finish_notes, created_by
          )
          values ($1,$2,$3,$4,$5,'Pending',$6,$7,$8)
          returning *
        `,
        [
          companyId,
          salesOrderId,
          order.customer_id,
          asInt(req.body?.assigned_engineer_id),
          toDateOnly(req.body?.scheduled_date),
          cleanText(req.body?.piping_infrastructure_status),
          cleanText(req.body?.welding_finish_notes),
          req.user.id,
        ]
      );
      await client.query("commit");
      return res.status(201).json({ ok: true, ticket: inserted.rows[0] });
    } catch (err) {
      await client.query("rollback");
      if (String(err?.code) === "23505") {
        return res.status(409).json({ ok: false, error: "TICKET_EXISTS_FOR_SO" });
      }
      return next(err);
    } finally {
      client.release();
    }
  }
);

router.patch(
  "/tickets/:id",
  requireScreenAction("field_service", "can_edit"),
  async (req, res, next) => {
    try {
      const id = asInt(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });
      const cur = await pool.query(`select * from commissioning_tickets where id = $1`, [id]);
      const row = cur.rows[0];
      if (!row) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      if (!canAccessCompanyContext(req, row)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      if (String(row.status) === "Completed") {
        return res.status(409).json({ ok: false, error: "ALREADY_COMPLETED" });
      }

      const nextStatus = req.body?.status != null ? String(req.body.status).trim() : null;
      if (nextStatus === "Completed") {
        return res.status(400).json({
          ok: false,
          error: "USE_COMPLETE_ENDPOINT",
          detail: "POST /field-service/tickets/:id/complete to enforce warranty and financial gates.",
        });
      }
      if (nextStatus && !["Pending", "In_Progress"].includes(nextStatus)) {
        return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
      }

      const updated = await pool.query(
        `
          update commissioning_tickets
          set
            assigned_engineer_id = coalesce($2, assigned_engineer_id),
            scheduled_date = coalesce($3::date, scheduled_date),
            status = coalesce($4, status),
            piping_infrastructure_status = coalesce($5, piping_infrastructure_status),
            welding_finish_notes = coalesce($6, welding_finish_notes),
            drive_file_id = coalesce($7, drive_file_id),
            updated_at = now()
          where id = $1
          returning *
        `,
        [
          id,
          asInt(req.body?.assigned_engineer_id),
          toDateOnly(req.body?.scheduled_date),
          nextStatus,
          cleanText(req.body?.piping_infrastructure_status),
          cleanText(req.body?.welding_finish_notes),
          asInt(req.body?.drive_file_id),
        ]
      );
      return res.json({ ok: true, ticket: updated.rows[0] });
    } catch (err) {
      return next(err);
    }
  }
);

router.post(
  "/tickets/:id/assign-engineer",
  requireScreenAction("field_service", "can_edit"),
  async (req, res, next) => {
    try {
      const id = asInt(req.params.id);
      const engineerId = asInt(req.body?.assigned_engineer_id || req.body?.engineer_id);
      if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });
      if (!engineerId) return res.status(400).json({ ok: false, error: "ENGINEER_REQUIRED" });

      const cur = await pool.query(`select * from commissioning_tickets where id = $1`, [id]);
      const row = cur.rows[0];
      if (!row) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      if (!canAccessCompanyContext(req, row)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      if (String(row.status) === "Completed") {
        return res.status(409).json({ ok: false, error: "ALREADY_COMPLETED" });
      }

      const eng = await pool.query(
        `select id, full_name, email from erp_users where id = $1 and is_active = true`,
        [engineerId]
      );
      if (!eng.rows[0]) return res.status(404).json({ ok: false, error: "ENGINEER_NOT_FOUND" });

      const updated = await pool.query(
        `
          update commissioning_tickets
          set assigned_engineer_id = $2, updated_at = now()
          where id = $1
          returning *
        `,
        [id, engineerId]
      );
      return res.json({
        ok: true,
        ticket: {
          ...updated.rows[0],
          assigned_engineer_name: eng.rows[0].full_name || eng.rows[0].email,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * Field complete — warranty clock + unlock commissioning milestones + emit event.
 */
async function handleTicketComplete(req, res, next) {
  const client = await pool.connect();
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    await client.query("begin");
    const cur = await client.query(`select * from commissioning_tickets where id = $1 for update`, [id]);
    const row = cur.rows[0];
    if (!row) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessCompanyContext(req, row)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const result = await completeCommissioningTicket(client, {
      ticketId: id,
      signoffDate: req.body?.client_signoff_date || new Date().toISOString().slice(0, 10),
      pipingStatus: cleanText(req.body?.piping_infrastructure_status),
      weldingNotes: cleanText(req.body?.welding_finish_notes),
      driveFileRegistryId: asInt(req.body?.drive_file_id),
      actorUserId: req.user.id,
    });

    await client.query("commit");

    const eventPayload = {
      sales_order_id: result.ticket.sales_order_id,
      commissioning_ticket_id: result.ticket.id,
      client_signoff_date: result.ticket.client_signoff_date,
      actor_user_id: req.user.id,
      warranty: result.warranty,
      financial: result.financial,
    };
    emitCommissioningCompleted(eventPayload);

    return res.json({
      ok: true,
      ticket: result.ticket,
      warranty: result.warranty,
      unlocked_milestones: result.financial.milestones,
      event: "commissioning:completed",
    });
  } catch (err) {
    await client.query("rollback");
    if (err?.status) {
      return res.status(err.status).json({ ok: false, error: err.code || err.message, detail: err.detail || null });
    }
    return next(err);
  } finally {
    client.release();
  }
}

router.post("/tickets/:id/complete", requireScreenAction("field_service", "can_edit"), handleTicketComplete);
router.patch("/tickets/:id/complete", requireScreenAction("field_service", "can_edit"), handleTicketComplete);

module.exports = router;
