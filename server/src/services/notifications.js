const webpush = require("web-push");
const { pool } = require("../db/pool");
const { sendChatDirectMessage } = require("./googleChatDm");

function appBaseUrl() {
  return String(process.env.APP_BASE_URL || "https://josh.absstem.com").replace(/\/$/, "");
}

function chatWebhookUrl() {
  return String(process.env.GOOGLE_CHAT_WEBHOOK_URL || "").trim();
}

function vapidConfig() {
  const publicKey = String(process.env.VAPID_PUBLIC_KEY || "").trim();
  const privateKey = String(process.env.VAPID_PRIVATE_KEY || "").trim();
  const subject = String(process.env.VAPID_SUBJECT || "mailto:ops@absstem.com").trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

function configureWebPush() {
  const cfg = vapidConfig();
  if (!cfg) return false;
  webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
  return true;
}

async function lookupUser(client, userId) {
  const { rows } = await client.query(
    `
      select id, full_name, email, google_user_id
      from erp_users
      where id = $1
      limit 1
    `,
    [userId]
  );
  return rows[0] || null;
}

function buildDeepLink(page, entityId, extra = {}) {
  const url = new URL(appBaseUrl() + "/");
  if (page) url.searchParams.set("page", page);
  if (entityId) url.searchParams.set("id", String(entityId));
  if (page === "leads") {
    url.searchParams.set("assignedTo", "me");
    if (entityId) url.searchParams.set("leadId", String(entityId));
  }
  if (page === "quotes" && entityId) {
    url.searchParams.set("quoteId", String(entityId));
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function buildChatPayload({ title, body, assigneeName, assigneeEmail, deepLink, eventType }) {
  const who = assigneeName || assigneeEmail || "Assignee";
  const emailLine = assigneeEmail ? `Email: ${assigneeEmail}` : "";
  // Incoming webhooks cannot reliably @mention Workspace users; emphasize name + email.
  return {
    cardsV2: [
      {
        cardId: `josh-${eventType || "notify"}-${Date.now()}`,
        card: {
          header: {
            title: `FOR: ${who}`,
            subtitle: title,
          },
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text: `<b>${escapeChat(who)}</b>${assigneeEmail ? ` &lt;${escapeChat(assigneeEmail)}&gt;` : ""}<br>${escapeChat(body)}${emailLine ? `<br>${escapeChat(emailLine)}` : ""}`,
                  },
                },
                deepLink
                  ? {
                      buttonList: {
                        buttons: [
                          {
                            text: "Open in Josh",
                            onClick: {
                              openLink: { url: deepLink },
                            },
                          },
                        ],
                      },
                    }
                  : null,
              ].filter(Boolean),
            },
          ],
        },
      },
    ],
    text: `FOR ${who}${assigneeEmail ? ` (${assigneeEmail})` : ""}: ${title} — ${body}${deepLink ? ` ${deepLink}` : ""}`,
  };
}

function escapeChat(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function postGoogleChat(payload) {
  const url = chatWebhookUrl();
  if (!url) return { ok: false, skipped: true };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      process.stderr.write(`Google Chat webhook failed: ${res.status} ${text}\n`);
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    process.stderr.write(`Google Chat webhook error: ${err?.message || err}\n`);
    return { ok: false, error: String(err?.message || err) };
  }
}

async function sendWebPushToUser(userId, payload) {
  if (!configureWebPush()) return { ok: false, skipped: true, reason: "not_configured" };
  const { rows } = await pool.query(
    `
      select id, endpoint, p256dh, auth
      from web_push_subscriptions
      where user_id = $1
    `,
    [userId]
  );
  if (!rows.length) return { ok: true, sent: 0 };

  let sent = 0;
  for (const row of rows) {
    try {
      await webpush.sendNotification(
        {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        },
        JSON.stringify(payload)
      );
      sent += 1;
    } catch (err) {
      const status = Number(err?.statusCode || 0);
      if (status === 404 || status === 410) {
        await pool.query(`delete from web_push_subscriptions where id = $1`, [row.id]).catch(() => {});
      } else {
        process.stderr.write(`Web push failed for sub ${row.id}: ${err?.message || err}\n`);
      }
    }
  }
  return { ok: true, sent };
}

async function recordChatDelivery(userId, result) {
  const reason = result?.ok ? null : String(result?.reason || "unknown").slice(0, 200);
  if (reason === "disabled" || reason === "not_configured") return;
  await pool.query(
    `
      insert into user_chat_delivery_status (user_id, last_attempt_at, last_ok_at, last_reason)
      values ($1, now(), case when $2 then now() end, $3)
      on conflict (user_id) do update
      set last_attempt_at = now(),
          last_ok_at = case when $2 then now() else user_chat_delivery_status.last_ok_at end,
          last_reason = $3
    `,
    [userId, Boolean(result?.ok), reason]
  );
}

/**
 * Private Google Chat DM first; the shared-space webhook is only a fallback when the DM
 * could not be delivered. Web push goes to every browser the user enabled.
 */
async function deliverSideChannels({ uid, user, title, body, deepLink, eventType, notificationId }) {
  const chatDm = await sendChatDirectMessage(
    { email: user.email, googleUserId: user.google_user_id },
    { title, body, deepLink, eventType }
  );
  recordChatDelivery(uid, chatDm).catch(() => {});
  const webhook = chatDm.ok
    ? { ok: false, skipped: true, reason: "dm_delivered" }
    : await postGoogleChat(
        buildChatPayload({ title, body, assigneeName: user.full_name, assigneeEmail: user.email, deepLink, eventType })
      ).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  const push = await sendWebPushToUser(uid, {
    title: `FOR ${user.full_name || user.email}: ${title}`,
    body,
    url: deepLink,
    notificationId: notificationId || null,
  }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  return { chat_dm: chatDm, chat_webhook: webhook, push };
}

/**
 * Create inbox row + Chat DM (or webhook fallback) + optional web push.
 * Fire-and-forget safe: callers should not fail the parent transaction on notify errors.
 * Pass awaitChannels: true to wait for delivery and get per-channel results.
 */
async function notifyUser({
  userId,
  companyId = null,
  eventType,
  title,
  body = "",
  page = null,
  entityId = null,
  payload = {},
  actorUserId = null,
  awaitChannels = false,
}) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return { ok: false, error: "INVALID_USER" };
  if (actorUserId != null && Number(actorUserId) === uid) {
    return { ok: true, skipped: true, reason: "self_assign" };
  }

  const client = await pool.connect();
  try {
    const user = await lookupUser(client, uid);
    if (!user) return { ok: false, error: "USER_NOT_FOUND" };

    const deepLink = buildDeepLink(page, entityId, payload?.query || {});
    const { rows } = await client.query(
      `
        insert into user_notifications (
          company_id,
          user_id,
          event_type,
          title,
          body,
          deep_link_page,
          deep_link_id,
          payload
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
        returning id, created_at
      `,
      [
        companyId || null,
        uid,
        String(eventType || "notice"),
        String(title || "Update").slice(0, 240),
        String(body || "").slice(0, 2000),
        page || null,
        entityId || null,
        JSON.stringify({ ...payload, deep_link: deepLink }),
      ]
    );

    const notification = rows[0];
    const channelArgs = { uid, user, title, body, deepLink, eventType, notificationId: notification?.id };

    if (awaitChannels) {
      const channels = await deliverSideChannels(channelArgs);
      return { ok: true, notification, channels };
    }

    setImmediate(() => {
      deliverSideChannels(channelArgs).catch(() => {});
    });

    return { ok: true, notification };
  } catch (err) {
    process.stderr.write(`notifyUser failed: ${err?.message || err}\n`);
    return { ok: false, error: String(err?.message || err) };
  } finally {
    client.release();
  }
}

async function notifyLeadAssigned({
  leadId,
  leadNumber,
  companyName,
  assignedTo,
  assignedBy,
  companyId,
  reason = "",
  assignSlaHours = null,
  requireNextActivity = false,
}) {
  const assigneeId = Number(assignedTo);
  const actorId = Number(assignedBy);
  if (!Number.isFinite(assigneeId)) return { ok: false };
  const label = leadNumber || `Lead #${leadId}`;
  const company = companyName ? ` · ${companyName}` : "";
  const why = reason ? ` Reason: ${reason}` : "";
  const slaHours = Number(assignSlaHours);
  const slaBit =
    Number.isFinite(slaHours) && slaHours > 0
      ? ` First response SLA: ${Math.trunc(slaHours)}h.`
      : "";
  const nextBit = requireNextActivity ? " Log the next activity before the SLA clock expires." : "";
  return notifyUser({
    userId: assigneeId,
    companyId,
    actorUserId: actorId,
    eventType: "lead_assigned",
    title: `${label} assigned to you`,
    body: `Open this lead and take the next sales step.${company}${why}${slaBit}${nextBit}`,
    page: "leads",
    entityId: leadId,
    payload: {
      lead_id: leadId,
      lead_number: leadNumber || null,
      company_name: companyName || null,
      assign_sla_hours: Number.isFinite(slaHours) && slaHours > 0 ? Math.trunc(slaHours) : null,
      require_next_activity: Boolean(requireNextActivity),
    },
  });
}

async function notifyLeadFollowUpDue({
  leadId,
  leadNumber,
  companyName,
  assignedTo,
  actorUserId = null,
  companyId = null,
  dueAt = null,
  activitySubject = "",
}) {
  const assigneeId = Number(assignedTo);
  if (!Number.isFinite(assigneeId)) return { ok: false };
  const label = leadNumber || `Lead #${leadId}`;
  const company = companyName ? ` · ${companyName}` : "";
  const dueLabel = dueAt ? ` Due ${new Date(dueAt).toLocaleString("en-IN")}.` : "";
  const subjectBit = activitySubject ? ` (${activitySubject})` : "";
  return notifyUser({
    userId: assigneeId,
    companyId,
    actorUserId,
    eventType: "lead_follow_up_due",
    title: `Follow-up due: ${label}`,
    body: `A lead follow-up was scheduled${subjectBit}.${dueLabel}${company}`,
    page: "leads",
    entityId: leadId,
    payload: {
      lead_id: leadId,
      lead_number: leadNumber || null,
      company_name: companyName || null,
      due_at: dueAt || null,
    },
  });
}

async function getPrimaryManagerUserId(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const { rows } = await pool.query(
    `select primary_manager_user_id from erp_users where id = $1 limit 1`,
    [id]
  );
  const managerId = Number(rows[0]?.primary_manager_user_id);
  return Number.isFinite(managerId) && managerId > 0 ? managerId : null;
}

async function notifyQuoteApprovalNeeded({
  quoteId,
  quoteNumber,
  approverUserId,
  requestedBy,
  companyId = null,
  stepLabel = "",
  triggeringLines = null,
}) {
  const quoteLabel = quoteNumber || `Quote #${quoteId}`;
  const lines = Array.isArray(triggeringLines) ? triggeringLines.slice(0, 3) : [];
  const lineHint = lines.length
    ? ` Trigger: ${lines
        .map((line) => `#${line.line_no || "?"} ${line.item_name || "line"} ${Number(line.discount_pct || 0).toFixed(1)}%`)
        .join("; ")}`
    : "";
  return notifyUser({
    userId: approverUserId,
    companyId,
    actorUserId: requestedBy,
    eventType: "quote_approval_needed",
    title: `Approval needed: ${quoteLabel}`,
    body: `${
      stepLabel
        ? `${quoteLabel} is waiting for your approval (${stepLabel}).`
        : `${quoteLabel} was submitted and needs your approval.`
    }${lineHint}`,
    page: "quotes",
    entityId: quoteId,
    payload: {
      quote_id: quoteId,
      quote_number: quoteNumber || null,
      triggering_lines: lines,
    },
  });
}

/**
 * Tells the quote's preparer what happened to it: approved, rejected, or sent by someone else.
 */
async function notifyQuoteOutcome({
  quoteId,
  quoteNumber,
  preparerUserId,
  actorUserId,
  companyId = null,
  outcome,
  actorName = "",
  remarks = "",
  recipientEmail = "",
}) {
  const quoteLabel = quoteNumber || `Quote #${quoteId}`;
  const by = actorName ? ` by ${actorName}` : "";
  const note = remarks ? ` Remarks: ${String(remarks).slice(0, 240)}` : "";
  const copy = {
    approved: {
      title: `Approved: ${quoteLabel}`,
      body: `${quoteLabel} was approved${by}. Issue it and send it to the customer.${note}`,
    },
    rejected: {
      title: `Rejected: ${quoteLabel}`,
      body: `${quoteLabel} was rejected${by}. Start a new revision to revise the offer.${note}`,
    },
    sent_by_other: {
      title: `Sent on your behalf: ${quoteLabel}`,
      body: `${quoteLabel} was emailed to ${recipientEmail || "the customer"}${by}. You were CC'd and replies come to you.`,
    },
    sent_from_your_address: {
      title: `Sent from your address: ${quoteLabel}`,
      body: `${quoteLabel} was emailed from your mailbox to ${recipientEmail || "the customer"}${by}. It is in your Sent folder and replies come to you.`,
    },
    owner_changed_to_you: {
      title: `Quote handed to you: ${quoteLabel}`,
      body: `You are now the owner of ${quoteLabel}${by}.${note}`,
    },
    owner_changed_from_you: {
      title: `Quote reassigned: ${quoteLabel}`,
      body: `${quoteLabel} was reassigned to another salesperson${by}.${note}`,
    },
  }[outcome];
  if (!copy) return { ok: false, skipped: true };
  return notifyUser({
    userId: preparerUserId,
    companyId,
    actorUserId,
    eventType: `quote_${outcome}`,
    title: copy.title,
    body: copy.body,
    page: "quotes",
    entityId: quoteId,
    payload: { quote_id: quoteId, quote_number: quoteNumber || null, outcome },
  });
}

async function notifyExpenseApprovalNeeded({
  claimId,
  employeeUserId,
  employeeName,
  purpose,
  amount,
  companyId,
  actorUserId,
}) {
  const managerId = await getPrimaryManagerUserId(employeeUserId);
  if (!managerId) return { ok: false, skipped: true, reason: "no_manager" };
  const amt = Number(amount || 0);
  return notifyUser({
    userId: managerId,
    companyId,
    actorUserId,
    eventType: "expense_approval_needed",
    title: "Expense claim needs your approval",
    body: `${employeeName || "Employee"}: ${purpose || "Expense"} · INR ${amt.toLocaleString("en-IN")}`,
    page: "expenses",
    entityId: claimId,
    payload: { claim_id: claimId, employee_user_id: employeeUserId || null },
  });
}

async function notifyLeaveApprovalNeeded({
  leaveId,
  employeeUserId,
  employeeName,
  leaveType,
  startDate,
  endDate,
  companyId,
  actorUserId,
}) {
  const managerId = await getPrimaryManagerUserId(employeeUserId);
  if (!managerId) return { ok: false, skipped: true, reason: "no_manager" };
  return notifyUser({
    userId: managerId,
    companyId,
    actorUserId,
    eventType: "leave_approval_needed",
    title: "Leave request needs your approval",
    body: `${employeeName || "Employee"}: ${leaveType || "Leave"} ${startDate || ""}–${endDate || ""}`,
    page: "leave",
    entityId: leaveId,
    payload: { leave_id: leaveId, employee_user_id: employeeUserId || null },
  });
}

async function notifyEngineeringAssigned({
  requestId,
  requestTitle,
  assignedToUserId,
  assignedBy,
  companyId,
  previousAssigneeId = null,
}) {
  const nextId = Number(assignedToUserId);
  if (!Number.isFinite(nextId) || nextId <= 0) return { ok: false, skipped: true };
  if (previousAssigneeId != null && Number(previousAssigneeId) === nextId) {
    return { ok: true, skipped: true, reason: "unchanged" };
  }
  return notifyUser({
    userId: nextId,
    companyId,
    actorUserId: assignedBy,
    eventType: "engineering_request_assigned",
    title: "Engineering request assigned to you",
    body: requestTitle || `Request #${requestId}`,
    page: "engineering_desk",
    entityId: requestId,
    payload: { request_id: requestId, request_title: requestTitle || null },
  });
}

async function notifyEngineeringSalesUpdate({
  requestId,
  requestTitle,
  requesterUserId,
  quoteHeaderId = null,
  companyId,
  actorUserId,
  status = "",
}) {
  const statusLabel = String(status || "").replace(/_/g, " ") || "updated";
  const quoteId = Number(quoteHeaderId);
  const hasQuote = Number.isFinite(quoteId) && quoteId > 0;
  const recipients = new Set();
  const requester = Number(requesterUserId);
  if (Number.isFinite(requester) && requester > 0) recipients.add(requester);
  if (hasQuote) {
    const ownerRes = await pool.query(`select created_by from quote_headers where id = $1`, [quoteId]).catch(() => ({ rows: [] }));
    const owner = Number(ownerRes.rows[0]?.created_by);
    if (Number.isFinite(owner) && owner > 0) recipients.add(owner);
  }
  recipients.delete(Number(actorUserId));
  if (!recipients.size) return { ok: true, skipped: true, reason: "no_recipient" };
  const results = [];
  for (const userId of recipients) {
    results.push(
      await notifyUser({
        userId,
        companyId,
        actorUserId,
        eventType: "engineering_sales_update",
        title: status === "waiting_input" ? "Engineering needs your input" : `Engineering ${statusLabel}`,
        body: requestTitle || `Request #${requestId}`,
        page: hasQuote ? "quotes" : "engineering_desk",
        entityId: hasQuote ? quoteId : requestId,
        payload: {
          request_id: requestId,
          quote_id: hasQuote ? quoteId : null,
          request_status: status || null,
        },
      })
    );
  }
  return { ok: true, results };
}

async function notifyEngineeringSalesReply({
  requestId,
  requestTitle,
  assignedToUserId,
  companyId,
  actorUserId,
  action = "reply",
}) {
  const userId = Number(assignedToUserId);
  if (!Number.isFinite(userId) || userId <= 0) return { ok: false, skipped: true, reason: "no_assignee" };
  if (Number(actorUserId) === userId) return { ok: true, skipped: true, reason: "self" };
  return notifyUser({
    userId,
    companyId,
    actorUserId,
    eventType: "engineering_sales_reply",
    title: action === "accept" ? "Sales accepted your engineering return" : "Sales replied to your engineering question",
    body: requestTitle || `Request #${requestId}`,
    page: "engineering_desk",
    entityId: requestId,
    payload: { request_id: requestId, action },
  });
}

async function notifyServiceTicketAssigned({
  ticketId,
  ticketNumber,
  assignedToUserId,
  assignedBy,
  companyId,
  customerName = "",
}) {
  return notifyUser({
    userId: assignedToUserId,
    companyId,
    actorUserId: assignedBy,
    eventType: "service_ticket_assigned",
    title: `${ticketNumber || `Ticket #${ticketId}`} assigned to you`,
    body: customerName ? `Service ticket for ${customerName}.` : "Open Service Tickets and plan the site visit.",
    page: "service_tickets",
    entityId: ticketId,
    payload: { ticket_id: ticketId, ticket_number: ticketNumber || null },
  });
}

async function listServiceTicketStakeholderIds({ companyId, createdByUserId, actorUserId }) {
  const recipients = new Set();
  const creatorId = Number(createdByUserId);
  const actorId = Number(actorUserId);
  if (Number.isFinite(creatorId) && creatorId > 0) recipients.add(creatorId);

  const company = Number(companyId);
  if (Number.isFinite(company) && company > 0) {
    const { rows } = await pool.query(
      `
        select distinct u.id
        from erp_users u
        join user_company_memberships ucm
          on ucm.user_id = u.id
         and ucm.is_active = true
         and ucm.company_id = $1
        join screen_permissions sp
          on sp.role_id = u.primary_role_id
         and sp.screen_key = 'service_tickets'
         and (sp.can_approve = true or sp.can_edit = true)
        where u.is_active = true
        limit 40
      `,
      [company]
    );
    for (const row of rows) {
      const id = Number(row.id);
      if (Number.isFinite(id) && id > 0) recipients.add(id);
    }
  }

  if (Number.isFinite(actorId)) recipients.delete(actorId);
  return [...recipients];
}

async function notifyServiceVisitCompleted({
  ticketId,
  ticketNumber,
  companyId,
  createdByUserId,
  actorUserId,
  visitStatus,
  hasSignedReport = false,
}) {
  const recipients = await listServiceTicketStakeholderIds({
    companyId,
    createdByUserId,
    actorUserId,
  });
  const label = ticketNumber || `Ticket #${ticketId}`;
  const title = hasSignedReport
    ? `Signed report uploaded: ${label}`
    : `Visit ${visitStatus || "updated"}: ${label}`;
  const body = hasSignedReport
    ? "Engineer uploaded a signed site visit report. Review Service Tickets."
    : `Engineer marked the site visit as ${visitStatus || "updated"}.`;

  const results = [];
  for (const userId of recipients) {
    results.push(
      // eslint-disable-next-line no-await-in-loop
      await notifyUser({
        userId,
        companyId,
        actorUserId,
        eventType: hasSignedReport ? "service_signed_report_uploaded" : "service_visit_completed",
        title,
        body,
        page: "service_tickets",
        entityId: ticketId,
        payload: { ticket_id: ticketId, ticket_number: ticketNumber || null, visit_status: visitStatus || null },
      })
    );
  }
  return { ok: true, notified: results.length };
}

async function listScreenStakeholderIds({ companyId, screenKey, actorUserId = null, preferEdit = true }) {
  const recipients = new Set();
  const company = Number(companyId);
  if (!Number.isFinite(company) || company <= 0) return [];
  const { rows } = await pool.query(
    `
      select distinct u.id
      from erp_users u
      join user_company_memberships ucm
        on ucm.user_id = u.id
       and ucm.is_active = true
       and ucm.company_id = $1
      join screen_permissions sp
        on sp.role_id = u.primary_role_id
       and sp.screen_key = $2
       and (
         sp.can_view = true
         or sp.can_edit = true
         or sp.can_approve = true
       )
      where u.is_active = true
        and (
          $3::boolean = false
          or sp.can_edit = true
          or sp.can_approve = true
        )
      limit 40
    `,
    [company, String(screenKey || ""), preferEdit === true]
  );
  for (const row of rows) {
    const id = Number(row.id);
    if (Number.isFinite(id) && id > 0) recipients.add(id);
  }
  const actorId = Number(actorUserId);
  if (Number.isFinite(actorId)) recipients.delete(actorId);
  return [...recipients];
}

async function notifyGrnShortClosed({
  purchaseOrderId,
  poNumber,
  vendorName = null,
  companyId,
  actorUserId,
  createdByUserId = null,
  pendingQtyClosed = 0,
}) {
  const recipients = new Set(await listScreenStakeholderIds({ companyId, screenKey: "three_way_match", actorUserId }));
  const creatorId = Number(createdByUserId);
  if (Number.isFinite(creatorId) && creatorId > 0 && creatorId !== Number(actorUserId)) recipients.add(creatorId);

  const title = `PO short-closed: ${poNumber || `#${purchaseOrderId}`}`;
  const body = vendorName
    ? `${vendorName} — remaining qty ${Number(pendingQtyClosed || 0).toFixed(2)} closed. Review 3-way match.`
    : `Remaining qty ${Number(pendingQtyClosed || 0).toFixed(2)} closed on receipt.`;

  const results = [];
  for (const userId of recipients) {
    results.push(
      // eslint-disable-next-line no-await-in-loop
      await notifyUser({
        userId,
        companyId,
        actorUserId,
        eventType: "grn_short_closed",
        title,
        body,
        page: "three_way_match",
        entityId: purchaseOrderId,
        payload: { po_id: purchaseOrderId, po_number: poNumber || null },
      })
    );
  }
  return { ok: true, notified: results.length };
}

async function notifyMatchBlocked({
  companyId,
  actorUserId,
  purchaseInvoiceIds = [],
  paymentId = null,
  vendorName = null,
}) {
  const recipients = await listScreenStakeholderIds({ companyId, screenKey: "three_way_match", actorUserId });
  if (!recipients.length) return { ok: true, notified: 0 };
  const ids = (Array.isArray(purchaseInvoiceIds) ? purchaseInvoiceIds : []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const title = "Vendor payment blocked by 3-way mismatch";
  const body = vendorName
    ? `${vendorName}: resolve PO/GRN/invoice qty before paying.`
    : "Resolve GRN / purchase invoice qty mismatch before posting payment.";

  const results = [];
  for (const userId of recipients) {
    results.push(
      // eslint-disable-next-line no-await-in-loop
      await notifyUser({
        userId,
        companyId,
        actorUserId,
        eventType: "match_blocked",
        title,
        body,
        page: "three_way_match",
        entityId: ids[0] || paymentId || null,
        payload: {
          purchase_invoice_ids: ids,
          payment_id: paymentId || null,
          po_id: null,
        },
      })
    );
  }
  return { ok: true, notified: results.length };
}

async function notifyCreditHoldSet({
  customerId,
  customerName,
  companyId,
  actorUserId,
  reason = "",
  accountManager = null,
}) {
  const recipients = new Set(await listScreenStakeholderIds({ companyId, screenKey: "ar_desk", actorUserId, preferEdit: false }));
  const managerHint = String(accountManager || "").trim().toLowerCase();
  if (managerHint) {
    const { rows } = await pool.query(
      `
        select id
        from erp_users
        where is_active = true
          and (
            lower(coalesce(email, '')) = $1
            or lower(coalesce(full_name, '')) = $1
          )
        limit 3
      `,
      [managerHint]
    );
    for (const row of rows) {
      const id = Number(row.id);
      if (Number.isFinite(id) && id > 0 && id !== Number(actorUserId)) recipients.add(id);
    }
  }

  const title = `Credit hold: ${customerName || `Customer #${customerId}`}`;
  const body = reason || "Customer commercial progression is blocked until hold is released.";
  const results = [];
  for (const userId of recipients) {
    results.push(
      // eslint-disable-next-line no-await-in-loop
      await notifyUser({
        userId,
        companyId,
        actorUserId,
        eventType: "credit_hold_set",
        title,
        body,
        page: "ar_desk",
        entityId: customerId,
        payload: { customer_id: customerId, customer_name: customerName || null },
      })
    );
  }
  return { ok: true, notified: results.length };
}

async function notifyDispatchNeedsInvoice({
  dispatchId,
  dispatchNumber,
  salesOrderId,
  companyId,
  actorUserId,
  createdByUserId = null,
  customerName = "",
}) {
  const recipients = new Set(await listScreenStakeholderIds({ companyId, screenKey: "invoices", actorUserId, preferEdit: true }));
  const creatorId = Number(createdByUserId);
  if (Number.isFinite(creatorId) && creatorId > 0 && creatorId !== Number(actorUserId)) recipients.add(creatorId);

  const title = `Dispatch needs invoice: ${dispatchNumber || `#${dispatchId}`}`;
  const body = customerName
    ? `${customerName} — create invoice from sales order after dispatch.`
    : "Dispatched without invoice. Open Sales Desk billing queue or Invoices.";

  const results = [];
  for (const userId of recipients) {
    results.push(
      // eslint-disable-next-line no-await-in-loop
      await notifyUser({
        userId,
        companyId,
        actorUserId,
        eventType: "dispatch_needs_invoice",
        title,
        body,
        page: "sales_desk",
        entityId: salesOrderId || dispatchId,
        payload: {
          dispatch_id: dispatchId,
          sales_order_id: salesOrderId || null,
          bucket: "dispatch_not_invoiced",
        },
      })
    );
  }
  return { ok: true, notified: results.length };
}

module.exports = {
  notifyUser,
  notifyLeadAssigned,
  notifyLeadFollowUpDue,
  notifyQuoteApprovalNeeded,
  notifyQuoteOutcome,
  notifyExpenseApprovalNeeded,
  notifyLeaveApprovalNeeded,
  notifyEngineeringAssigned,
  notifyEngineeringSalesUpdate,
  notifyEngineeringSalesReply,
  notifyServiceTicketAssigned,
  notifyServiceVisitCompleted,
  notifyGrnShortClosed,
  notifyMatchBlocked,
  notifyCreditHoldSet,
  notifyDispatchNeedsInvoice,
  getPrimaryManagerUserId,
  vapidConfig,
  appBaseUrl,
  buildDeepLink,
};
