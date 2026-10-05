const nodemailer = require("nodemailer");
const { OAuth2Client } = require("google-auth-library");
const { getDelegatedAccessToken } = require("./gmailDelegation");

let transporterPromise = null;

function envBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
}

function getMailerConfig() {
  const host = String(process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = envBool(process.env.SMTP_SECURE, false);
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "");
  const fromEmail = String(process.env.SMTP_FROM_EMAIL || "").trim();
  const fromName = String(process.env.SMTP_FROM_NAME || "JOSH ERP").trim();
  const replyTo = String(process.env.SMTP_REPLY_TO || "").trim();

  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure,
    user,
    pass,
    fromEmail,
    fromName,
    replyTo,
  };
}

function isMailConfigured() {
  const cfg = getMailerConfig();
  return Boolean(cfg.host && cfg.fromEmail);
}

function getGoogleMailConfig() {
  return {
    clientId: String(process.env.MAIL_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.MAIL_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || "").trim(),
  };
}

async function getTransporter() {
  if (!isMailConfigured()) {
    const err = new Error("SMTP_NOT_CONFIGURED");
    err.code = "SMTP_NOT_CONFIGURED";
    throw err;
  }

  if (!transporterPromise) {
    const cfg = getMailerConfig();
    transporterPromise = Promise.resolve(
      nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      })
    );
  }

  return transporterPromise;
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
  return tokenResponse?.token || null;
}

function b64UrlEncode(bufferOrText) {
  const buf = Buffer.isBuffer(bufferOrText) ? bufferOrText : Buffer.from(String(bufferOrText || ""), "utf8");
  return buf
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function isAsciiOnly(value) {
  return /^[\x20-\x7e]*$/.test(String(value || ""));
}

function encodeHeaderWord(value) {
  const text = String(value || "").replaceAll(/\r?\n/g, " ").trim();
  if (isAsciiOnly(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function encodeAddressHeader(value) {
  return String(value || "").replace(/"([^"]*)"\s*</g, (_m, name) =>
    isAsciiOnly(name) ? `"${name}" <` : `${encodeHeaderWord(name)} <`
  );
}

function wrapBase64(buf) {
  return (buf.toString("base64").match(/.{1,76}/g) || []).join("\r\n");
}

function mimeFilenameParams(filename) {
  const name = String(filename || "attachment").replaceAll(/[\r\n"]/g, "_");
  if (isAsciiOnly(name)) return { type: `name="${name}"`, disposition: `filename="${name}"` };
  const asciiFallback = name.replace(/[^\x20-\x7e]/g, "_");
  return {
    type: `name="${encodeHeaderWord(name)}"`,
    disposition: `filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  };
}

function buildMimeMessage({ from, replyTo, to, cc, bcc, subject, text, html, attachments }) {
  const safeSubject = encodeHeaderWord(subject);
  const boundaryMixed = `mixed_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const boundaryAlt = `alt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const hasHtml = typeof html === "string" && html.trim().length;
  const files = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  const hasAttachments = files.length > 0;

  const headerLines = [
    `From: ${encodeAddressHeader(from)}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${safeSubject}`,
    `MIME-Version: 1.0`,
  ].filter(Boolean);

  const textPart = [
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    wrapBase64(Buffer.from(String(text || ""), "utf8")),
    ``,
  ].join("\r\n");

  const htmlPart = hasHtml
    ? [
        `Content-Type: text/html; charset="UTF-8"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        wrapBase64(Buffer.from(String(html || ""), "utf8")),
        ``,
      ].join("\r\n")
    : "";

  const alternativeBlock = hasHtml
    ? [
        `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
        ``,
        `--${boundaryAlt}`,
        textPart,
        `--${boundaryAlt}`,
        htmlPart,
        `--${boundaryAlt}--`,
        ``,
      ].join("\r\n")
    : textPart;

  if (!hasAttachments) {
    return [...headerLines, ``, alternativeBlock].join("\r\n");
  }

  const parts = [];
  parts.push(`--${boundaryMixed}`);
  parts.push(alternativeBlock);

  for (const file of files) {
    const nameParams = mimeFilenameParams(file.filename);
    const contentType = String(file.contentType || "application/octet-stream");
    const content = file.content || Buffer.from("");
    const disposition = String(file.contentDisposition || (file.cid ? "inline" : "attachment"));
    parts.push(`--${boundaryMixed}`);
    parts.push(`Content-Type: ${contentType}; ${nameParams.type}`);
    parts.push(`Content-Disposition: ${disposition}; ${nameParams.disposition}`);
    if (file.cid) parts.push(`Content-ID: <${String(file.cid)}>` );
    parts.push(`Content-Transfer-Encoding: base64`);
    parts.push(``);
    parts.push(wrapBase64(Buffer.isBuffer(content) ? content : Buffer.from(content)));
    parts.push(``);
  }

  parts.push(`--${boundaryMixed}--`);
  parts.push(``);

  return [...headerLines, `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`, ``, ...parts].join("\r\n");
}

async function sendViaGmailApi({ senderSource, to, cc, bcc, subject, text, html, attachments, replyTo }) {
  const accessToken =
    senderSource?.type === "delegated_gmail"
      ? await getDelegatedAccessToken(senderSource.email)
      : await getGoogleAccessToken(senderSource?.account?.refresh_token || "");
  if (!accessToken) {
    const err = new Error("MAIL_GOOGLE_TOKEN_FAILED");
    err.code = "MAIL_GOOGLE_TOKEN_FAILED";
    throw err;
  }

  const from = senderSource.displayName ? `"${senderSource.displayName}" <${senderSource.email}>` : senderSource.email;
  const rawMime = buildMimeMessage({
    from,
    replyTo: replyTo || senderSource.email || undefined,
    to,
    cc: cc || undefined,
    bcc: bcc || undefined,
    subject,
    text,
    html,
    attachments,
  });

  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: b64UrlEncode(rawMime) }),
  });

  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    const err = new Error(bodyText || `GMAIL_API_SEND_FAILED_${resp.status}`);
    err.code = "GMAIL_API_SEND_FAILED";
    err.responseCode = resp.status;
    throw err;
  }

  const data = await resp.json().catch(() => ({}));
  return {
    messageId: data?.id || null,
    accepted: [],
    rejected: [],
  };
}

async function getTransportForSender(senderSource) {
  if (!senderSource || senderSource.type === "company_default") {
    const cfg = getMailerConfig();
    const transporter = await getTransporter();
    return {
      transporter,
      from: cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail,
      replyTo: cfg.replyTo || undefined,
    };
  }

  if (
    (senderSource.type === "user_oauth" || senderSource.type === "distributor_oauth" || senderSource.type === "delegated_gmail") &&
    senderSource.provider === "google"
  ) {
    return {
      transporter: null,
      from: senderSource.displayName ? `"${senderSource.displayName}" <${senderSource.email}>` : senderSource.email,
      replyTo: senderSource.email || undefined,
      isGmailApi: true,
    };
  }

  const err = new Error("MAIL_SOURCE_NOT_SUPPORTED");
  err.code = "MAIL_SOURCE_NOT_SUPPORTED";
  throw err;
}

async function sendMail({ to, cc, bcc, subject, text, html, attachments, replyTo, senderSource }) {
  const transportBundle = await getTransportForSender(senderSource);
  if (transportBundle.isGmailApi) {
    return sendViaGmailApi({
      senderSource,
      to,
      cc,
      bcc,
      subject,
      text,
      html,
      attachments,
      replyTo: replyTo || transportBundle.replyTo || undefined,
    });
  }
  const info = await transportBundle.transporter.sendMail({
    from: transportBundle.from,
    replyTo: replyTo || transportBundle.replyTo || undefined,
    to,
    cc: cc || undefined,
    bcc: bcc || undefined,
    subject,
    text,
    html: html || undefined,
    attachments: Array.isArray(attachments) ? attachments : undefined,
  });

  return {
    messageId: info?.messageId || null,
    accepted: Array.isArray(info?.accepted) ? info.accepted : [],
    rejected: Array.isArray(info?.rejected) ? info.rejected : [],
  };
}

module.exports = {
  buildMimeMessage,
  getMailerConfig,
  isMailConfigured,
  sendMail,
};
