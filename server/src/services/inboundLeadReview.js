const { OAuth2Client } = require("google-auth-library");

const REVIEWER_EMAILS = new Set(["arifa.z@absstem.com"]);
const DEFAULT_SYNC_INTERVAL_MINUTES = 15;
const MAILBOX_KEYS = ["contact", "indsales"];
const IGNORE_RULE_TYPES = new Set(["sender_email", "sender_domain", "subject_contains"]);

function normalizeMailboxKey(value) {
  const key = String(value || "").trim().toLowerCase();
  return MAILBOX_KEYS.includes(key) ? key : "";
}

function isAdminGroup(groupName) {
  const name = String(groupName || "").trim().toLowerCase();
  return name === "superadmin" || name === "admin";
}

function canAccessInboundLeadReview(user) {
  if (!user) return false;
  if (isAdminGroup(user.group_name)) return true;
  return REVIEWER_EMAILS.has(String(user.email || "").trim().toLowerCase());
}

function getInboundLeadReviewAccessError() {
  const err = new Error("FORBIDDEN");
  err.status = 403;
  err.code = "FORBIDDEN";
  return err;
}

function requireInboundLeadReviewAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (canAccessInboundLeadReview(req.user)) return next();
  return res.status(403).json({ ok: false, error: "FORBIDDEN" });
}

function requireInboundLeadReviewAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (isAdminGroup(req.user.group_name)) return next();
  return res.status(403).json({ ok: false, error: "FORBIDDEN" });
}

function getGoogleMailConfig() {
  return {
    clientId: String(process.env.MAIL_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.MAIL_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || "").trim(),
  };
}

async function getGoogleAccessToken(refreshToken) {
  const cfg = getGoogleMailConfig();
  if (!cfg.clientId || !cfg.clientSecret || !refreshToken) {
    const err = new Error("MAIL_GOOGLE_NOT_CONFIGURED");
    err.code = "MAIL_GOOGLE_NOT_CONFIGURED";
    throw err;
  }
  const client = new OAuth2Client(cfg.clientId, cfg.clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  const tokenResponse = await client.getAccessToken();
  const token = tokenResponse?.token || null;
  if (!token) {
    const err = new Error("MAIL_GOOGLE_TOKEN_FAILED");
    err.code = "MAIL_GOOGLE_TOKEN_FAILED";
    throw err;
  }
  return token;
}

async function gmailApiFetch(path, accessToken) {
  const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    const err = new Error(bodyText || `GMAIL_API_FAILED_${resp.status}`);
    err.code = "GMAIL_API_FAILED";
    err.responseCode = resp.status;
    throw err;
  }
  return resp.json();
}

function decodeBase64Url(value) {
  const input = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(`${input}${pad}`, "base64").toString("utf8");
}

function stripHtml(html) {
  return String(html || "")
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

function findBodyParts(payload, bucket = { text: "", html: "" }) {
  if (!payload || typeof payload !== "object") return bucket;
  if (payload.mimeType === "text/plain" && payload.body?.data && !bucket.text) {
    bucket.text = decodeBase64Url(payload.body.data);
  }
  if (payload.mimeType === "text/html" && payload.body?.data && !bucket.html) {
    bucket.html = decodeBase64Url(payload.body.data);
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      findBodyParts(part, bucket);
    }
  }
  return bucket;
}

function headerMap(headers) {
  const out = {};
  for (const item of Array.isArray(headers) ? headers : []) {
    const key = String(item?.name || "").trim().toLowerCase();
    if (!key) continue;
    out[key] = String(item?.value || "");
  }
  return out;
}

function parseFromHeader(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(.*?)(?:<([^>]+)>)?$/);
  const nameRaw = String(match?.[1] || "").replaceAll('"', "").trim();
  const emailRaw = String(match?.[2] || (text.includes("@") ? text : "")).trim().toLowerCase();
  return {
    name: nameRaw || emailRaw.split("@")[0] || "",
    email: emailRaw,
  };
}

function parseDateHeader(value) {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function titleCaseWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function deriveCompanyFromEmail(email) {
  const domain = String(email || "").split("@")[1] || "";
  const bare = domain.replace(/\.(com|in|co\.in|net|org|biz|co)$/i, "");
  const root = bare.split(".").slice(-1)[0] || "";
  if (!root || ["gmail", "outlook", "hotmail", "yahoo", "icloud", "rediffmail"].includes(root.toLowerCase())) {
    return "";
  }
  return titleCaseWords(root.replace(/[-_]+/g, " "));
}

function parsePhone(text) {
  const matches = String(text || "").match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || [];
  for (const raw of matches) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 15) return digits;
  }
  return "";
}

function parseCompany(text, fallbackEmail) {
  const lines = String(text || "").split("\n");
  for (const line of lines) {
    const match = line.match(/(?:company|organisation|organization|firm)\s*[:\-]\s*(.+)$/i);
    if (match?.[1]) return match[1].trim().slice(0, 200);
  }
  return deriveCompanyFromEmail(fallbackEmail);
}

function parseContactName(fromName, text) {
  const lines = String(text || "").split("\n");
  for (const line of lines) {
    const match = line.match(/(?:name|contact person|contact)\s*[:\-]\s*(.+)$/i);
    if (match?.[1]) return match[1].trim().slice(0, 200);
  }
  return String(fromName || "").trim().slice(0, 200);
}

function computeConfidence({ fromEmail, companyName, phone, subject, bodyText }) {
  let score = 20;
  if (fromEmail) score += 25;
  if (companyName) score += 20;
  if (phone) score += 20;
  if (String(subject || "").trim()) score += 10;
  if (String(bodyText || "").trim().length >= 40) score += 15;
  return Math.min(score, 100);
}

function normalizeSubjectForSignature(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^(re|fw|fwd)\s*:\s*/gi, "")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function normalizeBodyForSignature(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

function buildContentSignature({ fromEmail, subject, bodyText, bodyPreview }) {
  const sender = String(fromEmail || "").trim().toLowerCase();
  const subjectPart = normalizeSubjectForSignature(subject);
  const bodyPart = normalizeBodyForSignature(bodyPreview || bodyText);
  return `${sender}|${subjectPart}|${bodyPart}`.slice(0, 500);
}

function emailDomain(email) {
  return String(email || "").trim().toLowerCase().split("@")[1] || "";
}

function emailLocalPart(email) {
  return String(email || "").trim().toLowerCase().split("@")[0] || "";
}

function classifyInboundEmail({ fromEmail, fromName, subject, bodyText, mailboxKey = "", rules = [] }) {
  const sender = String(fromEmail || "").trim().toLowerCase();
  const senderDomain = emailDomain(sender);
  const senderLocal = emailLocalPart(sender);
  const senderName = String(fromName || "").trim().toLowerCase();
  const subjectText = String(subject || "").trim().toLowerCase();
  const body = String(bodyText || "").trim().toLowerCase();
  const normalizedMailbox = normalizeMailboxKey(mailboxKey);

  for (const rule of Array.isArray(rules) ? rules : []) {
    const ruleMailbox = normalizeMailboxKey(rule.mailbox_key);
    if (ruleMailbox && ruleMailbox !== normalizedMailbox) continue;
    const ruleType = String(rule.rule_type || "").trim().toLowerCase();
    const matchValue = String(rule.match_value || "").trim().toLowerCase();
    if (!matchValue) continue;
    if (ruleType === "sender_email" && sender === matchValue) {
      return {
        auto_ignore: true,
        reason: rule.reason || `Auto-ignored by rule: sender ${matchValue}.`,
        bucket: "manual_rule",
      };
    }
    if (ruleType === "sender_domain" && senderDomain === matchValue) {
      return {
        auto_ignore: true,
        reason: rule.reason || `Auto-ignored by rule: domain ${matchValue}.`,
        bucket: "manual_rule",
      };
    }
    if (ruleType === "subject_contains" && subjectText.includes(matchValue)) {
      return {
        auto_ignore: true,
        reason: rule.reason || `Auto-ignored by rule: subject contains "${matchValue}".`,
        bucket: "manual_rule",
      };
    }
  }

  const alertSignals = [
    "device id",
    "parameter:",
    "range:",
    "value:",
    "customer:",
    "absstem alerts",
    "iiot",
  ];
  const looksLikeInternalAlert =
    senderDomain.endsWith("absstem.com") &&
    (subjectText.includes("alert") ||
      senderName.includes("alert") ||
      alertSignals.some((signal) => body.includes(signal)));

  if (looksLikeInternalAlert) {
    return {
      auto_ignore: true,
      reason: "Auto-ignored: internal device/IIoT alert mail.",
      bucket: "system_alert",
    };
  }

  const linkedinDomains = ["linkedin.com", "linkedinmail.com"];
  const looksLikeLinkedIn =
    linkedinDomains.some((domain) => senderDomain === domain || senderDomain.endsWith(`.${domain}`)) ||
    sender.includes("linkedin") ||
    senderName.includes("linkedin") ||
    subjectText.includes("linkedin");

  if (looksLikeLinkedIn) {
    return {
      auto_ignore: true,
      reason: "Auto-ignored: LinkedIn/social notification mail.",
      bucket: "social_notification",
    };
  }

  const looksLikeNoReplyPromo =
    ["noreply", "no-reply", "do-not-reply"].includes(senderLocal) &&
    /(newsletter|subscription|update your profile|digest|weekly update)/i.test(`${subjectText}\n${body}`);

  if (looksLikeNoReplyPromo) {
    return {
      auto_ignore: true,
      reason: "Auto-ignored: no-reply newsletter/notification mail.",
      bucket: "promo_notification",
    };
  }

  return {
    auto_ignore: false,
    reason: "",
    bucket: "lead_review",
  };
}

function buildParsedEmail(message, options = {}) {
  const headers = headerMap(message?.payload?.headers);
  const from = parseFromHeader(headers.from);
  const parts = findBodyParts(message?.payload);
  const textBody = parts.text ? parts.text.trim() : stripHtml(parts.html);
  const subject = String(headers.subject || "").trim();
  const phone = parsePhone(textBody);
  const companyName = parseCompany(textBody, from.email);
  const contactName = parseContactName(from.name, textBody);
  const receivedAt = parseDateHeader(headers.date) || new Date().toISOString();
  const preview = String(textBody || message?.snippet || "").trim().slice(0, 500);
  const classification = classifyInboundEmail({
    fromEmail: from.email,
    fromName: from.name,
    subject,
    bodyText: textBody,
    mailboxKey: options.mailboxKey,
    rules: options.rules,
  });
  return {
    gmail_message_id: String(message?.id || "").trim(),
    gmail_thread_id: String(message?.threadId || "").trim() || null,
    internet_message_id: String(headers["message-id"] || "").trim() || null,
    received_at: receivedAt,
    from_name: from.name || null,
    from_email: from.email || null,
    subject: subject || "(No subject)",
    body_text: textBody || "",
    body_preview: preview,
    parse_contact_name: contactName || null,
    parse_company_name: companyName || null,
    parse_phone: phone || null,
    content_signature: buildContentSignature({
      fromEmail: from.email,
      subject,
      bodyText: textBody,
      bodyPreview: preview,
    }),
    confidence_score: computeConfidence({
      fromEmail: from.email,
      companyName,
      phone,
      subject,
      bodyText: textBody,
    }),
    review_status: classification.auto_ignore ? "ignored" : "pending",
    review_notes: classification.reason || null,
    raw_payload: {
      snippet: String(message?.snippet || ""),
      headers,
      classification,
    },
  };
}

async function loadIgnoreRules(client, mailboxKey = "") {
  const normalizedMailbox = normalizeMailboxKey(mailboxKey);
  const params = [];
  let where = `where is_active = true`;
  if (normalizedMailbox) {
    where += ` and (mailbox_key is null or mailbox_key = $1)`;
    params.push(normalizedMailbox);
  }
  const res = await client.query(
    `
      select *
      from inbound_lead_ignore_rules
      ${where}
      order by
        case when mailbox_key is null then 1 else 0 end,
        rule_type asc,
        id asc
    `,
    params
  );
  return res.rows;
}

async function listMailboxMessages(mailbox) {
  const accessToken = await getGoogleAccessToken(mailbox.refresh_token);
  const syncMinutes = Number(mailbox.sync_interval_minutes || DEFAULT_SYNC_INTERVAL_MINUTES);
  const fallbackAfter = Math.floor((Date.now() - Math.max(syncMinutes, 60) * 60 * 1000) / 1000);
  const lastSynced = mailbox.last_synced_at ? new Date(mailbox.last_synced_at).getTime() : null;
  const afterEpoch = Number.isFinite(lastSynced) ? Math.floor((lastSynced - 10 * 60 * 1000) / 1000) : fallbackAfter;
  const query = encodeURIComponent(`after:${Math.max(afterEpoch, fallbackAfter)}`);
  const list = await gmailApiFetch(`messages?q=${query}&maxResults=25`, accessToken);
  const messages = Array.isArray(list?.messages) ? list.messages : [];
  const detailed = [];
  for (const item of messages) {
    const msg = await gmailApiFetch(
      `messages/${encodeURIComponent(item.id)}?format=full&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`,
      accessToken
    );
    detailed.push(msg);
  }
  return detailed;
}

async function upsertInboundLeadEmail(client, mailbox, parsed) {
  let duplicateOfEmailId = null;
  let reviewStatus = parsed.review_status || "pending";
  let reviewNotes = parsed.review_notes || null;

  if (parsed.from_email && parsed.content_signature) {
    const duplicateRes = await client.query(
      `
        select id
        from inbound_lead_emails
        where mailbox_id = $1
          and lower(coalesce(from_email::text, '')) = lower($2)
          and content_signature = $3
          and gmail_message_id <> $4
        order by received_at desc nulls last, id desc
        limit 1
      `,
      [mailbox.id, parsed.from_email, parsed.content_signature, parsed.gmail_message_id]
    );
    duplicateOfEmailId = Number(duplicateRes.rows[0]?.id || 0) || null;
    if (duplicateOfEmailId && !["converted", "linked_existing"].includes(reviewStatus)) {
      reviewStatus = "ignored";
      reviewNotes = "Auto-ignored: duplicate mail already captured in review queue.";
    }
  }

  const result = await client.query(
    `
      insert into inbound_lead_emails (
        company_id,
        mailbox_id,
        gmail_message_id,
        gmail_thread_id,
        internet_message_id,
        received_at,
        from_name,
        from_email,
        subject,
        body_text,
        body_preview,
        parse_contact_name,
        parse_company_name,
        parse_phone,
        content_signature,
        confidence_score,
        review_status,
        review_notes,
        duplicate_of_email_id,
        raw_payload,
        updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now())
      on conflict (mailbox_id, gmail_message_id) do update set
        company_id = excluded.company_id,
        gmail_thread_id = excluded.gmail_thread_id,
        internet_message_id = excluded.internet_message_id,
        received_at = excluded.received_at,
        from_name = excluded.from_name,
        from_email = excluded.from_email,
        subject = excluded.subject,
        body_text = excluded.body_text,
        body_preview = excluded.body_preview,
        parse_contact_name = excluded.parse_contact_name,
        parse_company_name = excluded.parse_company_name,
        parse_phone = excluded.parse_phone,
        content_signature = excluded.content_signature,
        confidence_score = excluded.confidence_score,
        review_status = case
          when inbound_lead_emails.review_status in ('converted', 'linked_existing') then inbound_lead_emails.review_status
          else excluded.review_status
        end,
        review_notes = case
          when inbound_lead_emails.review_status in ('converted', 'linked_existing') then inbound_lead_emails.review_notes
          else excluded.review_notes
        end,
        duplicate_of_email_id = excluded.duplicate_of_email_id,
        raw_payload = excluded.raw_payload,
        updated_at = now()
      returning id
    `,
    [
      mailbox.company_id || null,
      mailbox.id,
      parsed.gmail_message_id,
      parsed.gmail_thread_id,
      parsed.internet_message_id,
      parsed.received_at,
      parsed.from_name,
      parsed.from_email,
      parsed.subject,
      parsed.body_text,
      parsed.body_preview,
      parsed.parse_contact_name,
      parsed.parse_company_name,
      parsed.parse_phone,
      parsed.content_signature || null,
      parsed.confidence_score,
      reviewStatus,
      reviewNotes,
      duplicateOfEmailId,
      parsed.raw_payload,
    ]
  );
  return Number(result.rows[0]?.id || 0);
}

async function syncMailbox(client, mailbox) {
  const messages = await listMailboxMessages(mailbox);
  const rules = await loadIgnoreRules(client, mailbox.mailbox_key);
  let touched = 0;
  for (const message of messages) {
    const parsed = buildParsedEmail(message, {
      mailboxKey: mailbox.mailbox_key,
      rules,
    });
    if (!parsed.gmail_message_id) continue;
    await upsertInboundLeadEmail(client, mailbox, parsed);
    touched += 1;
  }
  await client.query(
    `update inbound_mailboxes set last_synced_at = now(), last_error = null, updated_at = now() where id = $1`,
    [mailbox.id]
  );
  return touched;
}

async function syncMailboxByKey(pool, mailboxKey) {
  const key = normalizeMailboxKey(mailboxKey);
  if (!key) return { synced: 0, mailbox_key: "", ok: false };
  const client = await pool.connect();
  try {
    await client.query("begin");
    const mailboxRes = await client.query(
      `select * from inbound_mailboxes where mailbox_key = $1 and is_active = true limit 1`,
      [key]
    );
    const mailbox = mailboxRes.rows[0] || null;
    if (!mailbox) {
      await client.query("rollback");
      return { synced: 0, mailbox_key: key, ok: false, error: "MAILBOX_NOT_CONNECTED" };
    }
    const synced = await syncMailbox(client, mailbox);
    await client.query("commit");
    return { synced, mailbox_key: key, ok: true };
  } catch (err) {
    await client.query("rollback");
    await pool.query(
      `update inbound_mailboxes set last_error = $2, updated_at = now() where mailbox_key = $1`,
      [key, String(err?.message || err || "").slice(0, 500)]
    ).catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

async function syncAllDueMailboxes(pool) {
  const mailboxRes = await pool.query(
    `
      select *
      from inbound_mailboxes
      where is_active = true
        and provider = 'google'
        and (
          last_synced_at is null
          or last_synced_at <= now() - make_interval(mins => sync_interval_minutes)
        )
      order by mailbox_key asc
    `
  );
  const results = [];
  for (const mailbox of mailboxRes.rows) {
    try {
      const synced = await syncMailboxByKey(pool, mailbox.mailbox_key);
      results.push(synced);
    } catch (err) {
      results.push({
        mailbox_key: mailbox.mailbox_key,
        ok: false,
        synced: 0,
        error: String(err?.message || err || "").slice(0, 200),
      });
    }
  }
  return results;
}

async function syncAllMailboxes(pool) {
  const mailboxRes = await pool.query(
    `
      select mailbox_key
      from inbound_mailboxes
      where is_active = true
        and provider = 'google'
      order by mailbox_key asc
    `
  );
  const results = [];
  for (const row of mailboxRes.rows) {
    try {
      const synced = await syncMailboxByKey(pool, row.mailbox_key);
      results.push(synced);
    } catch (err) {
      results.push({
        mailbox_key: row.mailbox_key,
        ok: false,
        synced: 0,
        error: String(err?.message || err || "").slice(0, 200),
      });
    }
  }
  return results;
}

function startInboundLeadReviewWorker(pool) {
  const enabled = String(process.env.INBOUND_GMAIL_WORKER || "").trim().toLowerCase();
  // Opt-in only — IMAP fallback is the default unread ingest for indsales.
  if (!["1", "true", "yes", "on"].includes(enabled)) {
    return { started: false, reason: "disabled" };
  }
  const timer = setInterval(() => {
    syncAllDueMailboxes(pool).catch((err) => {
      process.stderr.write(`[inbound-gmail] ${err?.message || err}\n`);
    });
  }, Math.max(60, Number(process.env.INBOUND_GMAIL_POLL_SECONDS || 300)) * 1000);
  if (typeof timer.unref === "function") timer.unref();
  syncAllDueMailboxes(pool).catch(() => null);
  return { started: true, timer };
}

/**
 * Queue a raw inbound email into Inbound Lead Review (pending).
 * Runs Phase 3 extraction heuristics (+ mock SLM if needed).
 * Never inserts into leads.
 */
async function queueInboundEmailFromRaw(pool, {
  mailboxKey = "indsales",
  messageId,
  threadId = null,
  internetMessageId = null,
  receivedAt = null,
  fromName = "",
  fromEmail = "",
  subject = "",
  bodyText = "",
  rawMeta = null,
} = {}) {
  const key = normalizeMailboxKey(mailboxKey) || "indsales";
  const client = await pool.connect();
  try {
    await client.query("begin");
    const mailboxRes = await client.query(
      `select * from inbound_mailboxes where mailbox_key = $1 and is_active = true limit 1`,
      [key]
    );
    let mailbox = mailboxRes.rows[0] || null;
    if (!mailbox) {
      const ins = await client.query(
        `
          insert into inbound_mailboxes (
            mailbox_key, provider, mailbox_email, display_name, refresh_token,
            sync_interval_minutes, is_active, company_id
          )
          values (
            $1, 'imap', $2, 'Indsales IMAP fallback', 'imap-local', 5, true,
            (select id from companies where upper(company_code) = 'AI' order by id asc limit 1)
          )
          returning *
        `,
        [key, String(process.env.IMAP_USER || process.env.SMTP_USER || "indsales@absstem.com").trim()]
      );
      mailbox = ins.rows[0];
    }

    const rules = await loadIgnoreRules(client, key);
    const textBody = String(bodyText || "").trim();
    const preview = textBody.slice(0, 500);
    const subjectText = String(subject || "").trim() || "(No subject)";
    const senderEmail = String(fromEmail || "").trim().toLowerCase();
    const senderName = String(fromName || "").trim();

    const classification = classifyInboundEmail({
      fromEmail: senderEmail,
      fromName: senderName,
      subject: subjectText,
      bodyText: textBody,
      mailboxKey: key,
      rules,
    });

    let companyName = parseCompany(textBody, senderEmail);
    let parseContact = parseContactName(senderName, textBody);
    let parsePhoneVal = parsePhone(textBody);
    let confidence = computeConfidence({
      fromEmail: senderEmail,
      companyName,
      phone: parsePhoneVal,
      subject: subjectText,
      bodyText: textBody,
    });
    let extractionMeta = null;

    try {
      const { runExtractionPipeline } = require("./extraction/pipeline");
      const extraction = await runExtractionPipeline({
        docType: "inbound_email",
        text: textBody,
        meta: {
          subject: subjectText,
          from_name: senderName,
          from_email: senderEmail,
          body_preview: preview,
        },
      });
      extractionMeta = {
        source: extraction.source,
        used_slm: extraction.used_slm,
        confidence: extraction.confidence,
        confidence_label: extraction.confidence_label,
      };
      if (extraction.fields?.company_name) companyName = String(extraction.fields.company_name).trim();
      if (extraction.fields?.contact_name) parseContact = String(extraction.fields.contact_name).trim();
      if (extraction.fields?.phone) parsePhoneVal = String(extraction.fields.phone).trim();
      if (extraction.fields?.email && !senderEmail) {
        // keep senderEmail as primary; extraction email already from sender typically
      }
      confidence = Math.round(Number(extraction.confidence || 0) * 100);
    } catch (extractErr) {
      extractionMeta = { error: String(extractErr?.message || extractErr).slice(0, 200) };
    }

    const stableId =
      String(messageId || "").trim() ||
      String(internetMessageId || "").trim() ||
      `imap-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const parsed = {
      gmail_message_id: stableId.slice(0, 240),
      gmail_thread_id: threadId ? String(threadId).slice(0, 240) : null,
      internet_message_id: internetMessageId ? String(internetMessageId).slice(0, 500) : null,
      received_at: receivedAt || new Date().toISOString(),
      from_name: senderName || null,
      from_email: senderEmail || null,
      subject: subjectText,
      body_text: textBody,
      body_preview: preview,
      parse_contact_name: parseContact || null,
      parse_company_name: companyName || null,
      parse_phone: parsePhoneVal || null,
      content_signature: buildContentSignature({
        fromEmail: senderEmail,
        subject: subjectText,
        bodyText: textBody,
        bodyPreview: preview,
      }),
      confidence_score: confidence,
      review_status: classification.auto_ignore ? "ignored" : "pending",
      review_notes: classification.reason || null,
      raw_payload: {
        ingest: "imap",
        classification,
        extraction: extractionMeta,
        meta: rawMeta || null,
      },
    };

    const emailId = await upsertInboundLeadEmail(client, mailbox, parsed);
    await client.query(
      `update inbound_mailboxes set last_synced_at = now(), last_error = null, updated_at = now() where id = $1`,
      [mailbox.id]
    );
    await client.query("commit");
    return {
      ok: true,
      email_id: emailId,
      mailbox_key: key,
      review_status: parsed.review_status,
      extraction: extractionMeta,
    };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

async function getInboundLeadSourceId(client) {
  const existing = await client.query(`select id from lead_sources where source_code = 'EMAIL_INBOUND' limit 1`);
  const id = Number(existing.rows[0]?.id || 0);
  if (id > 0) return id;
  const inserted = await client.query(
    `
      insert into lead_sources (source_code, source_name, is_active)
      values ('EMAIL_INBOUND', 'Inbound Email Review', true)
      on conflict (source_code) do update set source_name = excluded.source_name, is_active = true
      returning id
    `
  );
  return Number(inserted.rows[0]?.id || 0);
}

function fallbackCompanyName(item) {
  return (
    String(item.parse_company_name || "").trim() ||
    deriveCompanyFromEmail(item.from_email) ||
    String(item.subject || "").trim().slice(0, 120) ||
    String(item.from_email || "Inbound Email").trim()
  );
}

function fallbackContactName(item) {
  return (
    String(item.parse_contact_name || "").trim() ||
    String(item.from_name || "").trim() ||
    String(item.from_email || "").split("@")[0] ||
    "Inbound Contact"
  );
}

async function createLeadFromInboundEmail(client, itemId, actorId, companyId) {
  if (!Number.isFinite(Number(companyId))) {
    const err = new Error("COMPANY_NOT_SELECTED");
    err.status = 400;
    throw err;
  }
  const intakeRes = await client.query(
    `
      select *
      from inbound_lead_emails
      where id = $1
      limit 1
    `,
    [Number(itemId)]
  );
  const item = intakeRes.rows[0] || null;
  if (!item) {
    const err = new Error("NOT_FOUND");
    err.status = 404;
    throw err;
  }
  if (item.converted_lead_id) return Number(item.converted_lead_id);
  const leadSourceId = await getInboundLeadSourceId(client);
  const numRes = await client.query(`select next_document_number('L') as lead_number`);
  const leadNumber = String(numRes.rows[0]?.lead_number || "").trim();
  const leadRes = await client.query(
    `
      insert into leads (
        lead_number,
        company_id,
        company_name,
        lead_source_id,
        status,
        priority,
        assigned_to,
        created_by
      )
      values ($1,$2,$3,$4,'new','medium',$5,$6)
      returning id, lead_number, company_name
    `,
    [leadNumber, Number(companyId), fallbackCompanyName(item), leadSourceId || null, actorId || null, actorId || null]
  );
  const lead = leadRes.rows[0];
  await client.query(
    `
      insert into lead_contacts (lead_id, full_name, email, phone, is_primary)
      values ($1,$2,$3,$4,true)
    `,
    [lead.id, fallbackContactName(item), item.from_email || null, item.parse_phone || null]
  );
  await client.query(
    `
      insert into lead_activities (lead_id, activity_type, subject, notes, created_by)
      values ($1,'note',$2,$3,$4)
    `,
    [
      lead.id,
      "Inbound email imported",
      `Mailbox: ${item.mailbox_id} | Subject: ${item.subject || "(No subject)"}

${String(item.body_preview || "").trim()}`.trim(),
      actorId || null,
    ]
  );
  try {
    const { insertTouchpoint } = require("./leadIngest");
    const { normalizePhoneDigits } = require("./leadPhone");
    await insertTouchpoint(client, {
      companyId: Number(companyId),
      leadId: lead.id,
      channel: "email_inbound",
      leadSourceId,
      contactName: fallbackContactName(item),
      email: item.from_email || null,
      phone: item.parse_phone || null,
      phoneDigits: normalizePhoneDigits(item.parse_phone) || null,
      companyName: fallbackCompanyName(item),
      matchMethod: "created_new",
      externalEventId: item.message_id || `inbound-${item.id}`,
    });
  } catch {
    /* touchpoints table may not exist until migration 182 */
  }
  await client.query(
    `
      update inbound_lead_emails
      set review_status = 'converted',
          converted_lead_id = $2,
          reviewed_by = $3,
          reviewed_at = now(),
          updated_at = now()
      where id = $1
    `,
    [item.id, lead.id, actorId || null]
  );
  return lead.id;
}

async function linkExistingLeadFromInboundEmail(client, itemId, leadId, actorId, companyId) {
  if (!Number.isFinite(Number(companyId))) {
    const err = new Error("COMPANY_NOT_SELECTED");
    err.status = 400;
    throw err;
  }
  const leadRes = await client.query(`select id, lead_number, company_name from leads where id = $1 and company_id = $2 limit 1`, [Number(leadId), Number(companyId)]);
  const lead = leadRes.rows[0] || null;
  if (!lead) {
    const err = new Error("LEAD_NOT_FOUND");
    err.status = 404;
    throw err;
  }
  await client.query(
    `
      update inbound_lead_emails
      set review_status = 'linked_existing',
          matched_lead_id = $2,
          reviewed_by = $3,
          reviewed_at = now(),
          updated_at = now()
      where id = $1
    `,
    [Number(itemId), lead.id, actorId || null]
  );
  await client.query(
    `
      insert into lead_activities (lead_id, activity_type, subject, notes, created_by)
      values ($1,'note',$2,$3,$4)
    `,
    [
      lead.id,
      "Inbound email linked",
      `Inbound email review entry linked instead of creating a new lead.`,
      actorId || null,
    ]
  );
  return lead.id;
}

async function ignoreInboundEmail(client, itemId, actorId, notes = "") {
  await client.query(
    `
      update inbound_lead_emails
      set review_status = 'ignored',
          review_notes = nullif($3, ''),
          reviewed_by = $2,
          reviewed_at = now(),
          updated_at = now()
      where id = $1
    `,
    [Number(itemId), actorId || null, String(notes || "").trim().slice(0, 500)]
  );
}

function normalizeIgnoreRuleInput(ruleType, item) {
  const type = String(ruleType || "").trim().toLowerCase();
  if (!IGNORE_RULE_TYPES.has(type)) {
    const err = new Error("INVALID_RULE_TYPE");
    err.status = 400;
    throw err;
  }
  const senderEmail = String(item.from_email || "").trim().toLowerCase();
  const senderDomain = emailDomain(senderEmail);
  const subject = normalizeSubjectForSignature(item.subject);

  if (type === "sender_email") {
    if (!senderEmail) {
      const err = new Error("RULE_VALUE_MISSING");
      err.status = 400;
      throw err;
    }
    return {
      ruleType: type,
      matchValue: senderEmail,
      reason: `Auto-ignored by reviewer rule: sender ${senderEmail}.`,
    };
  }
  if (type === "sender_domain") {
    if (!senderDomain) {
      const err = new Error("RULE_VALUE_MISSING");
      err.status = 400;
      throw err;
    }
    return {
      ruleType: type,
      matchValue: senderDomain,
      reason: `Auto-ignored by reviewer rule: domain ${senderDomain}.`,
    };
  }
  if (!subject) {
    const err = new Error("RULE_VALUE_MISSING");
    err.status = 400;
    throw err;
  }
  return {
    ruleType: type,
    matchValue: subject,
    reason: `Auto-ignored by reviewer rule: subject contains "${subject}".`,
  };
}

async function createIgnoreRuleFromEmail(client, itemId, ruleType, actorId) {
  const intakeRes = await client.query(
    `
      select e.*, m.mailbox_key
      from inbound_lead_emails e
      join inbound_mailboxes m on m.id = e.mailbox_id
      where e.id = $1
      limit 1
    `,
    [Number(itemId)]
  );
  const item = intakeRes.rows[0] || null;
  if (!item) {
    const err = new Error("NOT_FOUND");
    err.status = 404;
    throw err;
  }
  const normalized = normalizeIgnoreRuleInput(ruleType, item);
  const mailboxKey = normalizeMailboxKey(item.mailbox_key) || null;
  const existingRuleRes = await client.query(
    `
      select id
      from inbound_lead_ignore_rules
      where coalesce(mailbox_key, '') = coalesce($1, '')
        and rule_type = $2
        and lower(match_value) = lower($3)
      limit 1
    `,
    [mailboxKey, normalized.ruleType, normalized.matchValue]
  );
  let rule = null;
  const existingRuleId = Number(existingRuleRes.rows[0]?.id || 0);
  if (existingRuleId > 0) {
    const updateRes = await client.query(
      `
        update inbound_lead_ignore_rules
        set reason = $2,
            is_active = true,
            updated_at = now()
        where id = $1
        returning id, mailbox_key, rule_type, match_value, reason
      `,
      [existingRuleId, normalized.reason]
    );
    rule = updateRes.rows[0] || null;
  } else {
    const insertRes = await client.query(
      `
        insert into inbound_lead_ignore_rules (
          mailbox_key,
          rule_type,
          match_value,
          reason,
          created_by,
          is_active,
          updated_at
        )
        values ($1,$2,$3,$4,$5,true,now())
        returning id, mailbox_key, rule_type, match_value, reason
      `,
      [mailboxKey, normalized.ruleType, normalized.matchValue, normalized.reason, actorId || null]
    );
    rule = insertRes.rows[0] || null;
  }

  await client.query(
    `
      update inbound_lead_emails
      set review_status = 'ignored',
          review_notes = $2,
          reviewed_by = coalesce(reviewed_by, $3),
          reviewed_at = coalesce(reviewed_at, now()),
          updated_at = now()
      where id = $1
    `,
    [item.id, normalized.reason, actorId || null]
  );

  const whereParts = [`review_status = 'pending'`];
  const params = [normalized.reason];
  let idx = 2;
  if (rule.mailbox_key) {
    whereParts.push(`mailbox_id in (select id from inbound_mailboxes where mailbox_key = $${idx})`);
    params.push(rule.mailbox_key);
    idx += 1;
  }
  if (rule.rule_type === "sender_email") {
    whereParts.push(`lower(coalesce(from_email::text, '')) = $${idx}`);
    params.push(String(rule.match_value || "").toLowerCase());
    idx += 1;
  } else if (rule.rule_type === "sender_domain") {
    whereParts.push(`split_part(lower(coalesce(from_email::text, '')), '@', 2) = $${idx}`);
    params.push(String(rule.match_value || "").toLowerCase());
    idx += 1;
  } else if (rule.rule_type === "subject_contains") {
    whereParts.push(`lower(coalesce(subject, '')) like $${idx}`);
    params.push(`%${String(rule.match_value || "").toLowerCase()}%`);
    idx += 1;
  }
  await client.query(
    `
      update inbound_lead_emails
      set review_status = 'ignored',
          review_notes = $1,
          updated_at = now()
      where ${whereParts.join(" and ")}
    `,
    params
  );
  return rule;
}

async function findCandidateLeads(client, item, companyId = null) {
  if (!Number.isFinite(Number(companyId))) return [];
  const clauses = [];
  const params = [];
  let idx = 1;
  const email = String(item.from_email || "").trim().toLowerCase();
  const phone = String(item.parse_phone || "").trim();
  const company = String(item.parse_company_name || "").trim();
  if (email) {
    clauses.push(`exists (select 1 from lead_contacts lc where lc.lead_id = l.id and lower(coalesce(lc.email::text, '')) = $${idx})`);
    params.push(email);
    idx += 1;
  }
  if (phone) {
    clauses.push(`exists (select 1 from lead_contacts lc where lc.lead_id = l.id and regexp_replace(coalesce(lc.phone, ''), '\\D', '', 'g') = $${idx})`);
    params.push(phone.replace(/\D/g, ""));
    idx += 1;
  }
  if (company) {
    clauses.push(`lower(l.company_name) like $${idx}`);
    params.push(`%${company.toLowerCase()}%`);
    idx += 1;
  }
  if (!clauses.length) return [];
  const res = await client.query(
    `
      select l.id, l.lead_number, l.company_name, l.status
      from leads l
      where l.company_id = $${idx}
        and (${clauses.join(" or ")})
      order by l.updated_at desc nulls last, l.id desc
      limit 5
    `,
    [...params, Number(companyId)]
  );
  return res.rows;
}

function summarizeMailboxRow(row) {
  if (!row) {
    return {
      connected: false,
      mailbox_key: "",
      mailbox_email: "",
      display_name: "",
      company_id: null,
      sync_interval_minutes: DEFAULT_SYNC_INTERVAL_MINUTES,
      last_synced_at: null,
      last_error: null,
    };
  }
  return {
    connected: true,
    mailbox_key: row.mailbox_key,
    mailbox_email: row.mailbox_email || "",
    display_name: row.display_name || "",
    company_id: row.company_id || null,
    sync_interval_minutes: Number(row.sync_interval_minutes || DEFAULT_SYNC_INTERVAL_MINUTES),
    last_synced_at: row.last_synced_at || null,
    last_error: row.last_error || null,
  };
}

module.exports = {
  canAccessInboundLeadReview,
  createIgnoreRuleFromEmail,
  createLeadFromInboundEmail,
  findCandidateLeads,
  getInboundLeadReviewAccessError,
  ignoreInboundEmail,
  linkExistingLeadFromInboundEmail,
  normalizeMailboxKey,
  requireInboundLeadReviewAccess,
  requireInboundLeadReviewAdmin,
  REVIEWER_EMAILS,
  startInboundLeadReviewWorker,
  summarizeMailboxRow,
  syncAllMailboxes,
  syncAllDueMailboxes,
  syncMailboxByKey,
  queueInboundEmailFromRaw,
};
