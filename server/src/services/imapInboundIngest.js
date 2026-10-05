/**
 * IMAP unread-mail ingest for indsales@absstem.com.
 * Queues into Inbound Lead Review only — never auto-creates leads.
 */

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { queueInboundEmailFromRaw } = require("./inboundLeadReview");

function envBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

function getImapConfig() {
  const user = String(process.env.IMAP_USER || process.env.SMTP_USER || "").trim();
  const pass = String(process.env.IMAP_PASS || process.env.SMTP_PASS || "");
  const host = String(process.env.IMAP_HOST || process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.IMAP_PORT || 993);
  const secure = envBool(process.env.IMAP_SECURE, Number.isFinite(port) ? port === 993 : true);
  const mailbox = String(process.env.IMAP_MAILBOX || "INBOX").trim() || "INBOX";
  const pollSeconds = Math.max(30, Number(process.env.IMAP_POLL_SECONDS || 60) || 60);
  const enabled = envBool(process.env.IMAP_INGEST_ENABLED, Boolean(user && pass && host));

  return {
    enabled,
    user,
    pass,
    host,
    port: Number.isFinite(port) && port > 0 ? port : 993,
    secure,
    mailbox,
    pollSeconds,
    mailboxKey: String(process.env.IMAP_MAILBOX_KEY || "indsales").trim() || "indsales",
  };
}

function senderFromAddressObject(addr) {
  if (!addr) return { name: "", email: "" };
  if (Array.isArray(addr)) {
    const first = addr[0] || {};
    return {
      name: String(first.name || "").trim(),
      email: String(first.address || "").trim().toLowerCase(),
    };
  }
  return {
    name: String(addr.name || "").trim(),
    email: String(addr.address || addr.value?.[0]?.address || "").trim().toLowerCase(),
  };
}

function textFromParsed(parsed) {
  const plain = String(parsed?.text || "").trim();
  if (plain) return plain;
  const html = String(parsed?.html || "");
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function processUnreadOnce(pool, cfg = getImapConfig()) {
  if (!cfg.enabled) {
    return { ok: false, skipped: true, reason: "disabled_or_unconfigured" };
  }
  if (!cfg.host || !cfg.user || !cfg.pass) {
    return { ok: false, skipped: true, reason: "missing_credentials" };
  }

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    emitLogs: false,
  });

  let fetched = 0;
  let queued = 0;
  let marked = 0;
  const errors = [];

  // Prevent unhandled 'error' events from crashing the API process on IMAP timeouts.
  client.on("error", (err) => {
    errors.push({ socket: true, error: String(err?.message || err).slice(0, 240) });
    process.stderr.write(`[imap-ingest] socket error: ${err?.message || err}\n`);
  });

  try {
    await client.connect();
  } catch (err) {
    errors.push({ connect: true, error: String(err?.message || err).slice(0, 240) });
    process.stderr.write(`[imap-ingest] connect failed: ${err?.message || err}\n`);
    try {
      client.close();
    } catch {
      // ignore
    }
    return { ok: false, skipped: true, reason: "connect_failed", fetched, queued, marked, errors };
  }
  try {
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      // Strictly unread only.
      for await (const msg of client.fetch(
        { seen: false },
        {
          uid: true,
          envelope: true,
          source: true,
        }
      )) {
        fetched += 1;
        const uid = Number(msg.uid);
        try {
          const parsed = await simpleParser(msg.source);
          const from = senderFromAddressObject(parsed.from?.value?.[0] || parsed.from || msg.envelope?.from?.[0]);
          const subject = String(parsed.subject || msg.envelope?.subject || "").trim();
          const bodyText = textFromParsed(parsed);
          const internetMessageId = String(parsed.messageId || msg.envelope?.messageId || "").trim() || null;
          const receivedAt = parsed.date
            ? new Date(parsed.date).toISOString()
            : msg.envelope?.date
              ? new Date(msg.envelope.date).toISOString()
              : new Date().toISOString();

          const stableId = `imap:${cfg.user}:${uid}:${internetMessageId || subject.slice(0, 40)}`.slice(0, 240);

          const result = await queueInboundEmailFromRaw(pool, {
            mailboxKey: cfg.mailboxKey,
            messageId: stableId,
            threadId: null,
            internetMessageId,
            receivedAt,
            fromName: from.name,
            fromEmail: from.email,
            subject,
            bodyText,
            rawMeta: {
              imap_uid: uid,
              imap_host: cfg.host,
              imap_mailbox: cfg.mailbox,
              imap_user: cfg.user,
            },
          });

          if (result?.ok) queued += 1;

          // Mark read only after successful queue insert.
          await client.messageFlagsAdd({ uid }, ["\\Seen"], { uid: true });
          marked += 1;
        } catch (err) {
          errors.push({ uid, error: String(err?.message || err).slice(0, 240) });
          process.stderr.write(`[imap-ingest] uid=${uid} ${err?.message || err}\n`);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
    }
  }

  return { ok: true, fetched, queued, marked, errors };
}

function startImapInboundIngest(pool) {
  const cfg = getImapConfig();
  if (!cfg.enabled) {
    process.stdout.write("[imap-ingest] disabled (set IMAP_INGEST_ENABLED=true and IMAP/SMTP credentials)\n");
    return { started: false, reason: "disabled" };
  }
  if (!cfg.host || !cfg.user || !cfg.pass) {
    process.stdout.write("[imap-ingest] missing IMAP/SMTP host or credentials — not started\n");
    return { started: false, reason: "missing_credentials" };
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await processUnreadOnce(pool, cfg);
      if (result?.queued) {
        process.stdout.write(
          `[imap-ingest] queued=${result.queued} fetched=${result.fetched} marked_read=${result.marked}\n`
        );
      }
    } catch (err) {
      process.stderr.write(`[imap-ingest] poll failed: ${err?.message || err}\n`);
      await pool
        .query(
          `update inbound_mailboxes set last_error = $2, updated_at = now() where mailbox_key = $1`,
          [cfg.mailboxKey, String(err?.message || err).slice(0, 500)]
        )
        .catch(() => null);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    tick().catch(() => null);
  }, cfg.pollSeconds * 1000);
  if (typeof timer.unref === "function") timer.unref();

  // First poll shortly after boot.
  setTimeout(() => {
    tick().catch(() => null);
  }, 4000).unref?.();

  process.stdout.write(
    `[imap-ingest] listening on ${cfg.user} via ${cfg.host}:${cfg.port} every ${cfg.pollSeconds}s (unread only → Inbound Lead Review)\n`
  );

  return { started: true, timer, config: { host: cfg.host, port: cfg.port, user: cfg.user, pollSeconds: cfg.pollSeconds } };
}

module.exports = {
  getImapConfig,
  processUnreadOnce,
  startImapInboundIngest,
};
