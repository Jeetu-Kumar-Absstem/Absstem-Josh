const express = require("express");
const { pool } = require("../db/pool");
const { vapidConfig, notifyUser } = require("../services/notifications");
const { chatDmStatus, isEligibleEmail } = require("../services/googleChatDm");
const { canDelegateFor, delegationStatus } = require("../services/gmailDelegation");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

router.use(requireAuth);

router.get("/summary", async (req, res, next) => {
  try {
    const userId = asInt(req.user.id);
    const { rows } = await pool.query(
      `
        select count(*)::int as unread_count
        from user_notifications
        where user_id = $1
          and read_at is null
      `,
      [userId]
    );
    return res.json({ ok: true, unread_count: rows[0]?.unread_count || 0 });
  } catch (err) {
    return next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const userId = asInt(req.user.id);
    const unreadOnly = String(req.query.unread || "") === "1" || String(req.query.unread || "").toLowerCase() === "true";
    const limit = Math.min(Math.max(asInt(req.query.limit) || 30, 1), 100);
    const params = [userId];
    let where = "where user_id = $1";
    if (unreadOnly) where += " and read_at is null";
    params.push(limit);

    const { rows } = await pool.query(
      `
        select
          id,
          company_id,
          event_type,
          title,
          body,
          deep_link_page,
          deep_link_id,
          payload,
          read_at,
          created_at
        from user_notifications
        ${where}
        order by created_at desc, id desc
        limit $${params.length}
      `,
      params
    );
    return res.json({ ok: true, notifications: rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/read-all", async (req, res, next) => {
  try {
    const userId = asInt(req.user.id);
    const { rowCount } = await pool.query(
      `
        update user_notifications
        set read_at = now()
        where user_id = $1
          and read_at is null
      `,
      [userId]
    );
    return res.json({ ok: true, updated: rowCount || 0 });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/read", async (req, res, next) => {
  try {
    const userId = asInt(req.user.id);
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const { rows } = await pool.query(
      `
        update user_notifications
        set read_at = coalesce(read_at, now())
        where id = $1
          and user_id = $2
        returning id, read_at
      `,
      [id, userId]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, notification: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.get("/channels", async (req, res, next) => {
  try {
    const userId = asInt(req.user.id);
    const { rows } = await pool.query(
      `
        select
          (select count(*)::int from web_push_subscriptions where user_id = $1) as devices,
          (select google_user_id is not null from erp_users where id = $1) as google_linked
      `,
      [userId]
    );
    const chat = chatDmStatus();
    return res.json({
      ok: true,
      push: { configured: Boolean(vapidConfig()), devices: rows[0]?.devices || 0 },
      chat_dm: {
        configured: chat.enabled && chat.configured,
        eligible: isEligibleEmail(req.user.email),
        google_linked: Boolean(rows[0]?.google_linked),
        domain: chat.domain,
      },
      chat_webhook: { configured: Boolean(String(process.env.GOOGLE_CHAT_WEBHOOK_URL || "").trim()) },
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/test", async (req, res, next) => {
  try {
    const result = await notifyUser({
      userId: asInt(req.user.id),
      companyId: req.ctx?.company_id || null,
      eventType: "test_alert",
      title: "Test alert from Josh",
      body: "If you can see this, Josh can reach you on this channel.",
      awaitChannels: true,
    });
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error || "TEST_FAILED" });
    return res.json({ ok: true, channels: result.channels });
  } catch (err) {
    return next(err);
  }
});

function requireSuperAdmin(req, res, next) {
  if (req.user?.group_name !== "SuperAdmin") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  return next();
}

function chatReadinessState(row, chat) {
  if (!chat.enabled || !chat.configured) return "chat_not_configured";
  if (!isEligibleEmail(row.email)) return "outside_domain";
  if (!row.google_linked) return "needs_google_sign_in";
  if (!row.last_attempt_at) return "untested";
  if (!row.last_reason) return "ready";
  if (row.last_reason === "app_not_installed_for_user") return "app_not_installed";
  return "failing";
}

router.get("/chat-readiness", requireSuperAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `
        select
          u.id, u.full_name, u.email, g.group_name,
          (u.google_user_id is not null) as google_linked,
          s.last_attempt_at, s.last_ok_at, s.last_reason,
          (select count(*)::int from web_push_subscriptions w where w.user_id = u.id) as push_devices
        from erp_users u
        left join user_groups g on g.id = u.group_id
        left join user_chat_delivery_status s on s.user_id = u.id
        where u.is_active = true
        order by u.full_name asc
      `
    );
    const chat = chatDmStatus();
    const delegation = delegationStatus();
    const users = rows.map((row) => ({
      ...row,
      state: chatReadinessState(row, chat),
      can_send_as: canDelegateFor(row.email),
    }));
    const counts = users.reduce((acc, u) => ({ ...acc, [u.state]: (acc[u.state] || 0) + 1 }), {});
    return res.json({
      ok: true,
      chat: { enabled: chat.enabled, configured: chat.configured, domain: chat.domain, app_account: chat.app_account },
      gmail_delegation: {
        enabled: Boolean(delegation.enabled),
        configured: Boolean(delegation.configured),
        domain: delegation.domain,
        client_id: delegation.client_id,
        scope: delegation.scope,
      },
      counts,
      users,
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/chat-readiness/:userId/test", requireSuperAdmin, async (req, res, next) => {
  try {
    const userId = asInt(req.params.userId);
    if (!userId) return res.status(400).json({ ok: false, error: "INVALID_USER" });
    const actorId = asInt(req.user.id);
    const result = await notifyUser({
      userId,
      companyId: req.ctx?.company_id || null,
      // notifyUser drops self-sent alerts; a test on your own row must still go out.
      actorUserId: actorId === userId ? null : actorId,
      eventType: "test_alert",
      title: "Test alert from Josh",
      body: `${req.user.full_name || "Your admin"} is checking that Josh alerts reach you in Google Chat. No action needed.`,
      awaitChannels: true,
    });
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error || "TEST_FAILED" });
    return res.json({ ok: true, channels: result.channels });
  } catch (err) {
    return next(err);
  }
});

router.get("/push/vapid-public-key", (_req, res) => {
  const cfg = vapidConfig();
  if (!cfg) return res.status(503).json({ ok: false, error: "PUSH_NOT_CONFIGURED" });
  return res.json({ ok: true, publicKey: cfg.publicKey });
});

router.post("/push/subscribe", async (req, res, next) => {
  try {
    const userId = asInt(req.user.id);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const endpoint = String(body.endpoint || "").trim();
    const p256dh = String(body.keys?.p256dh || body.p256dh || "").trim();
    const auth = String(body.keys?.auth || body.auth || "").trim();
    const userAgent = String(req.headers["user-agent"] || "").slice(0, 400);
    if (!endpoint || !p256dh || !auth) return res.status(400).json({ ok: false, error: "INVALID_SUBSCRIPTION" });

    await pool.query(
      `
        insert into web_push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
        values ($1,$2,$3,$4,$5)
        on conflict (user_id, endpoint)
        do update set p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent
      `,
      [userId, endpoint, p256dh, auth, userAgent || null]
    );
    return res.status(201).json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

router.delete("/push/subscribe", async (req, res, next) => {
  try {
    const userId = asInt(req.user.id);
    const endpoint = String(req.body?.endpoint || req.query?.endpoint || "").trim();
    if (!endpoint) return res.status(400).json({ ok: false, error: "ENDPOINT_REQUIRED" });
    await pool.query(`delete from web_push_subscriptions where user_id = $1 and endpoint = $2`, [userId, endpoint]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
