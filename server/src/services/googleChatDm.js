const crypto = require("crypto");
const fs = require("fs");

const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHAT_API = "https://chat.googleapis.com/v1";
const SPACE_CACHE_MS = 6 * 60 * 60 * 1000;
const MISS_CACHE_MS = 10 * 60 * 1000;

let cachedCredentials;
let cachedToken = null;
const spaceCache = new Map();

function dmEnabledFlag() {
  return String(process.env.GOOGLE_CHAT_DM_ENABLED || "").trim().toLowerCase() === "true";
}

function allowedDomain() {
  return String(process.env.GOOGLE_CHAT_DM_DOMAIN || "absstem.com").trim().toLowerCase().replace(/^@/, "");
}

function loadCredentials() {
  if (cachedCredentials !== undefined) return cachedCredentials;
  cachedCredentials = null;
  try {
    let raw = String(process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON || "").trim();
    const file = String(process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_FILE || "").trim();
    if (!raw && file) raw = fs.readFileSync(file, "utf8");
    if (!raw) return null;
    if (!raw.startsWith("{")) raw = Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(raw);
    if (parsed.client_email && parsed.private_key) {
      cachedCredentials = { client_email: parsed.client_email, private_key: parsed.private_key };
    }
  } catch (err) {
    process.stderr.write(`Google Chat DM credentials could not be loaded: ${err?.message || err}\n`);
  }
  return cachedCredentials;
}

function chatDmStatus() {
  const creds = dmEnabledFlag() ? loadCredentials() : null;
  return {
    enabled: dmEnabledFlag(),
    configured: Boolean(creds),
    domain: allowedDomain(),
    app_account: creds?.client_email || null,
  };
}

function isEligibleEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return Boolean(e) && e.endsWith(`@${allowedDomain()}`);
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const creds = loadCredentials();
  if (!creds) throw new Error("CHAT_DM_NOT_CONFIGURED");
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: creds.client_email, scope: CHAT_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })
  );
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(creds.private_key).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
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
    throw new Error(`CHAT_TOKEN_FAILED ${res.status} ${data.error || ""} ${data.error_description || ""}`.trim());
  }
  cachedToken = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

async function findDirectMessageSpace(googleUserId) {
  const key = String(googleUserId).trim();
  const hit = spaceCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.space;
  const token = await getAccessToken();
  const res = await fetch(`${CHAT_API}/spaces:findDirectMessage?name=${encodeURIComponent(`users/${key}`)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) {
    spaceCache.set(key, { space: null, expiresAt: Date.now() + MISS_CACHE_MS });
    return null;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`CHAT_FIND_DM_FAILED ${res.status} ${data?.error?.message || ""}`.trim());
  const space = data.name || null;
  spaceCache.set(key, { space, expiresAt: Date.now() + (space ? SPACE_CACHE_MS : MISS_CACHE_MS) });
  return space;
}

function escapeChat(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildDmMessage({ title, body, deepLink, eventType }) {
  return {
    text: `*${String(title || "Josh").slice(0, 200)}*`,
    cardsV2: [
      {
        cardId: `josh-${eventType || "notify"}-${Date.now()}`,
        card: {
          sections: [
            {
              widgets: [
                body ? { textParagraph: { text: escapeChat(body) } } : null,
                deepLink
                  ? { buttonList: { buttons: [{ text: "Open in Josh", onClick: { openLink: { url: deepLink } } }] } }
                  : null,
              ].filter(Boolean),
            },
          ],
        },
      },
    ],
  };
}

/**
 * Sends a private Google Chat message from the Josh Chat app to one Workspace user.
 * googleUserId is the account ID saved at Google sign-in; Chat rejects email lookups for apps.
 * Returns { ok, skipped?, reason? } and never throws.
 */
async function sendChatDirectMessage({ email, googleUserId }, { title, body, deepLink, eventType }) {
  try {
    if (!dmEnabledFlag()) return { ok: false, skipped: true, reason: "disabled" };
    if (!loadCredentials()) return { ok: false, skipped: true, reason: "not_configured" };
    if (!isEligibleEmail(email)) return { ok: false, skipped: true, reason: "outside_domain" };
    if (!googleUserId) return { ok: false, skipped: true, reason: "sign_in_with_google_needed" };
    const space = await findDirectMessageSpace(googleUserId);
    if (!space) return { ok: false, skipped: true, reason: "app_not_installed_for_user" };
    const token = await getAccessToken();
    const res = await fetch(`${CHAT_API}/${space}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(buildDmMessage({ title, body, deepLink, eventType })),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 404 || res.status === 403) spaceCache.delete(String(googleUserId).trim());
      process.stderr.write(`Google Chat DM failed for ${email}: ${res.status} ${data?.error?.message || ""}\n`);
      return { ok: false, reason: `http_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    process.stderr.write(`Google Chat DM error for ${email}: ${err?.message || err}\n`);
    return { ok: false, reason: String(err?.message || err).slice(0, 160) };
  }
}

module.exports = {
  chatDmStatus,
  isEligibleEmail,
  sendChatDirectMessage,
};
