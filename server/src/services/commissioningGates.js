const { domainEvents } = require("./domainEvents");

/**
 * Physical → financial commissioning gates for PSA plant delivery.
 * - Site readiness Approved is required before dispatch create.
 * - Commissioning Completed + client_signoff_date starts warranty and unlocks
 *   payment_milestones with due_type = 'commissioning' (locked → ready_to_bill).
 */

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  return text.slice(0, 10);
}

async function getSiteReadinessForSalesOrder(client, salesOrderId) {
  const r = await client.query(
    `
      select *
      from site_readiness_checklists
      where sales_order_id = $1
      limit 1
    `,
    [asInt(salesOrderId)]
  );
  return r.rows[0] || null;
}

/**
 * Dispatch create gate. Throws error with .status / .code for route handlers.
 */
async function assertSiteReadinessApprovedForDispatch(client, salesOrderId) {
  const row = await getSiteReadinessForSalesOrder(client, salesOrderId);
  if (!row) {
    const err = new Error("SITE_READINESS_REQUIRED");
    err.status = 409;
    err.code = "SITE_READINESS_REQUIRED";
    err.detail = "Create and approve a site readiness checklist before scheduling dispatch.";
    throw err;
  }
  if (String(row.status) !== "Approved") {
    const err = new Error("SITE_READINESS_NOT_APPROVED");
    err.status = 409;
    err.code = "SITE_READINESS_NOT_APPROVED";
    err.detail = `Site readiness status is ${row.status}; dispatch requires Approved.`;
    throw err;
  }
  return row;
}

async function resolveWarrantyMonths(client, salesOrderId) {
  const r = await client.query(
    `
      select qr.warranty_months
      from sales_orders so
      left join quote_revisions qr on qr.id = so.quote_revision_id
      where so.id = $1
      limit 1
    `,
    [asInt(salesOrderId)]
  );
  const months = asInt(r.rows[0]?.warranty_months);
  return months && months > 0 ? months : 12;
}

/**
 * Warranty gate: set job_assets.warranty_start_date (+ commissioning_date, warranty_end)
 * for all assets on the sales order.
 */
async function applyWarrantyStartFromCommissioning(client, { salesOrderId, signoffDate, actorUserId }) {
  const start = toDateOnly(signoffDate);
  if (!start) {
    const err = new Error("CLIENT_SIGNOFF_DATE_REQUIRED");
    err.status = 400;
    err.code = "CLIENT_SIGNOFF_DATE_REQUIRED";
    throw err;
  }

  const months = await resolveWarrantyMonths(client, salesOrderId);
  const updated = await client.query(
    `
      update job_assets
      set
        commissioning_date = coalesce(commissioning_date, $2::date),
        warranty_start_date = $2::date,
        warranty_end_date = ($2::date + make_interval(months => $3::int))::date,
        updated_at = now()
      where sales_order_id = $1
      returning id, job_id, serial_no, warranty_start_date, warranty_end_date
    `,
    [asInt(salesOrderId), start, months]
  );

  return {
    warranty_months: months,
    assets: updated.rows,
    actor_user_id: actorUserId || null,
  };
}

/**
 * Financial gate: unlock commissioning milestones (locked → ready_to_bill).
 * Emits domain event for AR listeners.
 */
async function unlockCommissioningMilestones(client, { salesOrderId, actorUserId, commissioningTicketId }) {
  const unlocked = await client.query(
    `
      update payment_milestones
      set
        status = 'ready_to_bill',
        unlocked_at = now(),
        unlocked_by = $2,
        unlock_event = 'commissioning:completed',
        updated_at = now()
      where sales_order_id = $1
        and due_type = 'commissioning'
        and status = 'locked'
      returning id, milestone_name, milestone_percent, milestone_amount_order, status
    `,
    [asInt(salesOrderId), asInt(actorUserId)]
  );

  // Also unlock by name heuristic if due_type was never set but still locked/pending named commissioning
  const byName = await client.query(
    `
      update payment_milestones
      set
        due_type = 'commissioning',
        status = 'ready_to_bill',
        unlocked_at = now(),
        unlocked_by = $2,
        unlock_event = 'commissioning:completed',
        updated_at = now()
      where sales_order_id = $1
        and lower(coalesce(milestone_name, '')) ~ 'commission'
        and status in ('locked', 'pending')
        and id <> all($3::int[])
      returning id, milestone_name, milestone_percent, milestone_amount_order, status
    `,
    [
      asInt(salesOrderId),
      asInt(actorUserId),
      unlocked.rows.map((r) => r.id).length ? unlocked.rows.map((r) => r.id) : [0],
    ]
  );

  const milestones = [...unlocked.rows, ...byName.rows];

  const payload = {
    sales_order_id: asInt(salesOrderId),
    commissioning_ticket_id: asInt(commissioningTicketId),
    actor_user_id: asInt(actorUserId),
    milestones,
  };

  // Emit after successful DB work (caller should commit first, or emit after commit)
  return payload;
}

/**
 * Complete a commissioning ticket: status Completed, warranty + financial gates.
 * Expects an open transaction on `client`. Caller commits, then should call emitCommissioningCompleted.
 */
async function completeCommissioningTicket(client, { ticketId, signoffDate, pipingStatus, weldingNotes, driveFileRegistryId, actorUserId }) {
  const id = asInt(ticketId);
  const signoff = toDateOnly(signoffDate);
  if (!id) {
    const err = new Error("INVALID_TICKET_ID");
    err.status = 400;
    err.code = "INVALID_TICKET_ID";
    throw err;
  }
  if (!signoff) {
    const err = new Error("CLIENT_SIGNOFF_DATE_REQUIRED");
    err.status = 400;
    err.code = "CLIENT_SIGNOFF_DATE_REQUIRED";
    throw err;
  }

  const ticketRes = await client.query(
    `
      select *
      from commissioning_tickets
      where id = $1
      for update
    `,
    [id]
  );
  const ticket = ticketRes.rows[0];
  if (!ticket) {
    const err = new Error("NOT_FOUND");
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }
  if (String(ticket.status) === "Completed") {
    const err = new Error("ALREADY_COMPLETED");
    err.status = 409;
    err.code = "ALREADY_COMPLETED";
    throw err;
  }

  const updatedTicket = await client.query(
    `
      update commissioning_tickets
      set
        status = 'Completed',
        client_signoff_date = $2::date,
        piping_infrastructure_status = coalesce($3, piping_infrastructure_status),
        welding_finish_notes = coalesce($4, welding_finish_notes),
        drive_file_id = coalesce($5, drive_file_id),
        completed_at = now(),
        completed_by = $6,
        updated_at = now()
      where id = $1
      returning *
    `,
    [
      id,
      signoff,
      pipingStatus != null ? String(pipingStatus).slice(0, 4000) : null,
      weldingNotes != null ? String(weldingNotes).slice(0, 4000) : null,
      asInt(driveFileRegistryId),
      asInt(actorUserId),
    ]
  );

  const warranty = await applyWarrantyStartFromCommissioning(client, {
    salesOrderId: ticket.sales_order_id,
    signoffDate: signoff,
    actorUserId,
  });

  const financial = await unlockCommissioningMilestones(client, {
    salesOrderId: ticket.sales_order_id,
    actorUserId,
    commissioningTicketId: id,
  });

  return {
    ticket: updatedTicket.rows[0],
    warranty,
    financial,
  };
}

function emitCommissioningCompleted(payload) {
  domainEvents.emit("commissioning:completed", payload);
}

/** Register default AR log listener (safe, idempotent). */
function registerDefaultCommissioningListeners() {
  if (registerDefaultCommissioningListeners._done) return;
  registerDefaultCommissioningListeners._done = true;

  domainEvents.on("commissioning:completed", (payload) => {
    const so = payload?.sales_order_id;
    const n = Array.isArray(payload?.financial?.milestones) ? payload.financial.milestones.length : 0;
    process.stdout.write(
      `[commissioning:completed] so=${so} unlocked_milestones=${n} assets=${payload?.warranty?.assets?.length || 0}\n`
    );
  });
}

module.exports = {
  getSiteReadinessForSalesOrder,
  assertSiteReadinessApprovedForDispatch,
  applyWarrantyStartFromCommissioning,
  unlockCommissioningMilestones,
  completeCommissioningTicket,
  emitCommissioningCompleted,
  registerDefaultCommissioningListeners,
};
