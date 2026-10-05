const express = require("express");
const passport = require("passport");
const crypto = require("crypto");

const { pool } = require("../db/pool");
const {
  deactivateMailAccount,
  getMailAccountByOwner,
  getMailBootstrap,
  isGoogleMailConfigured,
  upsertMailAccount,
} = require("../services/mailAccounts");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (req.user.group_name !== "SuperAdmin") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  return next();
}

function getAppBaseUrl() {
  return process.env.APP_BASE_URL || "http://localhost:5173";
}

function sanitizeRedirect(redirectTo) {
  const base = getAppBaseUrl();
  const value = typeof redirectTo === "string" ? redirectTo.trim() : "";
  if (!value) return base;
  if (value.startsWith(base)) return value;
  if (value.startsWith("/")) return `${base}${value}`;
  return base;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value) {
  const raw = String(value || "").trim().replaceAll("-", "+").replaceAll("_", "/");
  const pad = raw.length % 4 ? "=".repeat(4 - (raw.length % 4)) : "";
  return Buffer.from(`${raw}${pad}`, "base64").toString("utf8");
}

function signMailOAuthState(payload) {
  const secret = String(process.env.SESSION_SECRET || "").trim();
  if (!secret) return "";
  const body = base64UrlEncode(JSON.stringify(payload || {}));
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${body}.${sig}`;
}

function verifyMailOAuthState(state) {
  const secret = String(process.env.SESSION_SECRET || "").trim();
  const token = typeof state === "string" ? state.trim() : "";
  if (!secret || !token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  if (expected !== sig) return null;
  try {
    const parsed = JSON.parse(base64UrlDecode(body));
    const ts = Number(parsed?.ts || 0);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    if (Date.now() - ts > 20 * 60 * 1000) return null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function ensureDistributorExists(distributorId) {
  const r = await pool.query(`select id, company_name from distributors where id = $1 limit 1`, [distributorId]);
  return r.rows[0] || null;
}

router.use(requireAuth);

router.get("/bootstrap", async (req, res, next) => {
  try {
    const quoteId = Number(req.query.quote_id);
    const quoteDistributorId = Number.isFinite(quoteId)
      ? (
          await pool.query(`select distributor_id from quote_headers where id = $1 limit 1`, [quoteId])
        ).rows[0]?.distributor_id || null
      : null;

    const bootstrap = await getMailBootstrap(pool, {
      userId: req.user.id,
      userGroupName: req.user.group_name,
      quoteDistributorId,
    });

    return res.json({
      ok: true,
      ...bootstrap,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/google/connect", async (req, res, next) => {
  try {
    if (!isGoogleMailConfigured()) return res.status(400).json({ ok: false, error: "MAIL_GOOGLE_NOT_CONFIGURED" });

    const pending = {
      owner_type: "user",
      owner_user_id: req.user.id,
      redirect_to: sanitizeRedirect(req.query.redirectTo),
    };
    req.session.pendingMailOAuth = pending;
    const state = signMailOAuthState({ ...pending, ts: Date.now() });

    return passport.authenticate("google-mail", {
      scope: ["openid", "profile", "email", "https://www.googleapis.com/auth/gmail.send"],
      accessType: "offline",
      prompt: "select_account consent",
      session: false,
      loginHint: req.user?.email || undefined,
      state: state || undefined,
    })(req, res, next);
  } catch (err) {
    return next(err);
  }
});

router.get("/google/connect/distributor/:id", requireSuperAdmin, async (req, res, next) => {
  try {
    if (!isGoogleMailConfigured()) return res.status(400).json({ ok: false, error: "MAIL_GOOGLE_NOT_CONFIGURED" });

    const distributorId = Number(req.params.id);
    if (!Number.isFinite(distributorId)) return res.status(400).json({ ok: false });
    const distributor = await ensureDistributorExists(distributorId);
    if (!distributor) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    const pending = {
      owner_type: "distributor",
      distributor_id: distributorId,
      connected_by: req.user.id,
      redirect_to: sanitizeRedirect(req.query.redirectTo),
    };
    req.session.pendingMailOAuth = pending;
    const state = signMailOAuthState({ ...pending, ts: Date.now() });

    return passport.authenticate("google-mail", {
      scope: ["openid", "profile", "email", "https://www.googleapis.com/auth/gmail.send"],
      accessType: "offline",
      prompt: "select_account consent",
      session: false,
      state: state || undefined,
    })(req, res, next);
  } catch (err) {
    return next(err);
  }
});

router.get("/google/callback", (req, res, next) => {
  const rawState = typeof req.query.state === "string" ? req.query.state : "";
  const pending = req.session?.pendingMailOAuth || verifyMailOAuthState(rawState);
  if (!pending) {
    return res.redirect(sanitizeRedirect("/?mail_connect=failed&mail_reason=missing_state"));
  }

  return passport.authenticate("google-mail", { session: false }, async (err, payload) => {
    const redirectTo = sanitizeRedirect(pending.redirect_to);
    req.session.pendingMailOAuth = null;

    if (err || !payload?.mailboxEmail) {
      return res.redirect(`${redirectTo}${redirectTo.includes("?") ? "&" : "?"}mail_connect=failed&mail_reason=oauth_failed`);
    }

    if (!payload.refreshToken) {
      return res.redirect(`${redirectTo}${redirectTo.includes("?") ? "&" : "?"}mail_connect=refresh_required&mail_reason=no_refresh_token`);
    }

    try {
      await upsertMailAccount(pool, {
        ownerType: pending.owner_type,
        userId: pending.owner_user_id,
        distributorId: pending.distributor_id,
        provider: "google",
        mailboxEmail: payload.mailboxEmail,
        displayName: payload.displayName,
        refreshToken: payload.refreshToken,
        accessToken: payload.accessToken,
        connectedBy: pending.connected_by || req.user?.id || pending.owner_user_id,
      });

      return res.redirect(`${redirectTo}${redirectTo.includes("?") ? "&" : "?"}mail_connect=success`);
    } catch (saveErr) {
      return next(saveErr);
    }
  })(req, res, next);
});

router.post("/me/disconnect", async (req, res, next) => {
  try {
    await deactivateMailAccount(pool, { ownerType: "user", userId: req.user.id });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

const EMAIL_SIGNATURE_MAX_CHARS = 600;

router.get("/me/signature", async (req, res, next) => {
  try {
    const r = await pool.query(`select full_name, designation, phone, email, email_signature from erp_users where id = $1`, [req.user.id]);
    const row = r.rows[0] || {};
    const suggested = [row.full_name, row.designation, row.phone, row.email].map((v) => String(v || "").trim()).filter(Boolean).join("\n");
    return res.json({ ok: true, email_signature: row.email_signature || "", suggested_signature: suggested });
  } catch (err) {
    return next(err);
  }
});

router.put("/me/signature", async (req, res, next) => {
  try {
    const raw = typeof req.body?.email_signature === "string" ? req.body.email_signature : "";
    const cleaned = raw
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .trim();
    if (cleaned.length > EMAIL_SIGNATURE_MAX_CHARS) {
      return res.status(400).json({ ok: false, error: "SIGNATURE_TOO_LONG", max_chars: EMAIL_SIGNATURE_MAX_CHARS });
    }
    await pool.query(`update erp_users set email_signature = $2, updated_at = now() where id = $1`, [req.user.id, cleaned || null]);
    return res.json({ ok: true, email_signature: cleaned });
  } catch (err) {
    return next(err);
  }
});

router.post("/distributor/:id/disconnect", requireSuperAdmin, async (req, res, next) => {
  try {
    const distributorId = Number(req.params.id);
    if (!Number.isFinite(distributorId)) return res.status(400).json({ ok: false });
    const distributor = await ensureDistributorExists(distributorId);
    if (!distributor) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    await deactivateMailAccount(pool, { ownerType: "distributor", distributorId });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

router.get("/distributor/:id", requireSuperAdmin, async (req, res, next) => {
  try {
    const distributorId = Number(req.params.id);
    if (!Number.isFinite(distributorId)) return res.status(400).json({ ok: false });
    const account = await getMailAccountByOwner(pool, { ownerType: "distributor", distributorId });
    return res.json({
      ok: true,
      account: account
        ? {
            connected: true,
            provider: account.provider,
            mailbox_email: account.mailbox_email,
            display_name: account.display_name,
            updated_at: account.updated_at,
          }
        : {
            connected: false,
            provider: "google",
            mailbox_email: "",
            display_name: "",
          },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
