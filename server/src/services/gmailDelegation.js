const crypto = require("crypto");
const fs = require("fs");

/**
 * Sends Gmail as any Workspace user through a service account with domain-wide delegation
 * (Admin console > Security > API controls > Domain-wide delegation, scope gmail.send).
 * Reuses the Chat service-account key unless a separate file is configured.
 */

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FAILURE_CACHE_MS = 10 * 60 * 1000;

let cachedCredentials;
const tokenCache = new Map();
const failureCache = new Map();

function delegationEnabled() {
  return String(process.env.GOOGLE_GMAIL_DELEGATION_ENABLED || "").trim().toLowerCase() === "true";
}

function delegationDomain() {
  return String(process.env.GOOGLE_GMAIL_DELEGATION_DOMAIN || process.env.GOOGLE_CHAT_DM_DOMAIN || "absstem.com")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
}

function loadCredentials() {
  if (cachedCredentials !== undefined) return cachedCredentials;
  cachedCredentials = null;
  try {
    const file = String(
      process.env.GOOGLE_GMAIL_DELEGATION_SERVICE_ACCOUNT_FILE || process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_FILE || ""
    ).trim();
    let raw = String(process.env.GOOGLE_GMAIL_DELEGATION_SERVICE_ACCOUNT_JSON || "").trim();
    if (!raw && file) raw = fs.readFileSync(file, "utf8");
    if (!raw) return null;
    if (!raw.startsWith("{")) raw = Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(raw);
    if (parsed.client_email && parsed.private_key) {
      cachedCredentials = {
        client_email: parsed.client_email,
        client_id: parsed.client_id || null,
        private_key: parsed.private_key,
      };
    }
  } catch (err) {
    process.stderr.write(`Gmail delegation credentials could not be loaded: ${err?.message || err}\n`);
  }
  return cachedCredentials;
}

function delegationStatus() {
  const creds = delegationEnabled() ? loadCredentials() : null;
  return {
    enabled: delegationEnabled(),
    configured: Boolean(creds),
    domain: delegationDomain(),
    service_account: creds?.client_email || null,
    client_id: creds?.client_id || null,
    scope: GMAIL_SEND_SCOPE,
  };
}

function canDelegateFor(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !e.endsWith(`@${delegationDomain()}`)) return false;
  return delegationEnabled() && Boolean(loadCredentials());
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getDelegatedAccessToken(email) {
  const subject = String(email || "").trim().toLowerCase();
  if (!canDelegateFor(subject)) {
    const err = new Error("GMAIL_DELEGATION_NOT_AVAILABLE");
    err.code = "GMAIL_DELEGATION_NOT_AVAILABLE";
    throw err;
  }
  const hit = tokenCache.get(subject);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const failed = failureCache.get(subject);
  if (failed && failed.until > Date.now()) {
    const err = new Error(failed.message);
    err.code = "GMAIL_DELEGATION_FAILED";
    throw err;
  }

  const creds = loadCredentials();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: creds.client_email, sub: subject, scope: GMAIL_SEND_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })
  );
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = base64url(signer.sign(creds.private_key));
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const message = `GMAIL_DELEGATION_FAILED ${res.status} ${data.error || ""} ${data.error_description || ""}`.trim();
    failureCache.set(subject, { until: Date.now() + FAILURE_CACHE_MS, message });
    const err = new Error(message);
    err.code = "GMAIL_DELEGATION_FAILED";
    throw err;
  }
  failureCache.delete(subject);
  tokenCache.set(subject, { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 });
  return data.access_token;
}

/** Returns { ok, reason } without throwing; used to pick the sender before sending. */
async function probeDelegation(email) {
  try {
    await getDelegatedAccessToken(email);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err).slice(0, 200) };
  }
}

module.exports = {
  canDelegateFor,
  delegationStatus,
  getDelegatedAccessToken,
  probeDelegation,
};
