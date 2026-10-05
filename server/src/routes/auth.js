const express = require("express");
const passport = require("passport");
const crypto = require("crypto");

const { pool } = require("../db/pool");
const { loadUserContextById } = require("../auth/userContext");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (req.user.group_name !== "SuperAdmin") {
    return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  }
  return next();
}

function scryptHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) return reject(err);
      return resolve(derivedKey.toString("base64"));
    });
  });
}

function normalizeCompanyId(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function resolveDefaultActiveCompanyId(user, sessionCompanyId) {
  const companies = Array.isArray(user?.companies) ? user.companies : [];
  const isSuper = user?.group_name === "SuperAdmin";
  const fromSession = normalizeCompanyId(sessionCompanyId);
  if (fromSession && (isSuper || companies.some((c) => Number(c.company_id) === fromSession))) {
    return fromSession;
  }
  const primary = normalizeCompanyId(user?.primary_company_id);
  if (primary && (isSuper || companies.some((c) => Number(c.company_id) === primary))) return primary;
  const first = normalizeCompanyId(companies[0]?.company_id);
  if (first && (isSuper || companies.some((c) => Number(c.company_id) === first))) return first;
  return null;
}

router.get("/google", (req, res, next) => {
  const redirectTo =
    typeof req.query.redirectTo === "string" ? req.query.redirectTo : "";

  const authenticator = passport.authenticate("google", {
    scope: ["openid", "profile", "email"],
    prompt: "select_account",
    state: redirectTo,
  });

  return authenticator(req, res, next);
});

router.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: "/auth/unauthorized" }),
  (req, res) => {
    const base = process.env.APP_BASE_URL || "http://localhost:5173";
    const state =
      typeof req.query.state === "string" && req.query.state.length
        ? req.query.state
        : "";
    const safeRedirect = state.startsWith(base)
      ? state
      : state.startsWith("/")
        ? `${base}${state}`
        : "";

    res.redirect(safeRedirect || base);
  }
);

router.get("/unauthorized", (_req, res) => {
  const base = String(process.env.APP_BASE_URL || "http://localhost:5173").replace(/\/$/, "");
  const msg = encodeURIComponent(
    "Your Google account is not provisioned in JOSH or is pending approval. If this is your first login, an approval request has been sent to SuperAdmin."
  );
  return res.redirect(`${base}/?authError=${msg}`);
});

router.post("/local/login", async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !password) return res.status(400).json({ ok: false });

    const { rows } = await pool.query(
      `
        select
          u.id,
          u.is_approved,
          c.password_salt,
          c.password_hash,
          c.password_algo
        from erp_users u
        join user_credentials c on c.user_id = u.id
        where u.email = $1 and u.is_active = true
        limit 1
      `,
      [email]
    );

    const user = rows[0] || null;
    if (!user) return res.status(401).json({ ok: false });
    if (user.is_approved !== true) return res.status(403).json({ ok: false, error: "PENDING_APPROVAL" });
    if (user.password_algo !== "scrypt") return res.status(401).json({ ok: false });

    const computed = await scryptHash(password, user.password_salt);
    const a = Buffer.from(computed);
    const b = Buffer.from(user.password_hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false });
    }

    req.session.localUserId = user.id;
    const contextUser = await loadUserContextById(pool, user.id);
    const activeCompanyId = resolveDefaultActiveCompanyId(contextUser, req.session.activeCompanyId);
    if (activeCompanyId) req.session.activeCompanyId = activeCompanyId;
    return res.json({
      ok: true,
      user: { ...contextUser, active_company_id: activeCompanyId },
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/local/set-password", requireSuperAdmin, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !password) return res.status(400).json({ ok: false });

    const userRes = await pool.query(
      `select id from erp_users where email = $1 and is_active = true limit 1`,
      [email]
    );
    const userId = userRes.rows[0]?.id;
    if (!userId) return res.status(404).json({ ok: false });

    const salt = crypto.randomBytes(16).toString("base64");
    const hash = await scryptHash(password, salt);

    await pool.query(
      `
        insert into user_credentials (user_id, password_salt, password_hash, password_algo, updated_at)
        values ($1,$2,$3,'scrypt',now())
        on conflict (user_id) do update set
          password_salt = excluded.password_salt,
          password_hash = excluded.password_hash,
          password_algo = excluded.password_algo,
          updated_at = now()
      `,
      [userId, salt, hash]
    );

    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

router.post("/local/link-distributor", requireSuperAdmin, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const distributorId = Number(body.distributor_id);
    if (!email || !Number.isFinite(distributorId)) return res.status(400).json({ ok: false });

    const userRes = await pool.query(
      `select id from erp_users where email = $1 and is_active = true limit 1`,
      [email]
    );
    const userId = userRes.rows[0]?.id;
    if (!userId) return res.status(404).json({ ok: false });

    await pool.query(
      `
        insert into user_distributor_links (user_id, distributor_id)
        values ($1,$2)
        on conflict (user_id) do update set distributor_id = excluded.distributor_id
      `,
      [userId, distributorId]
    );

    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

router.post("/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session?.destroy(() => res.json({ ok: true }));
  });
});

router.get("/session", (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false });
  const activeCompanyId = resolveDefaultActiveCompanyId(req.user, req.session?.activeCompanyId);
  if (req.user.group_name !== "SuperAdmin") {
    if (!activeCompanyId) {
      return res.status(403).json({ ok: false, error: "NO_COMPANY_ACCESS" });
    }
    if (req.session) req.session.activeCompanyId = activeCompanyId;
  } else if (activeCompanyId && req.session) {
    req.session.activeCompanyId = activeCompanyId;
  }
  return res.json({
    ok: true,
    user: { ...req.user, active_company_id: activeCompanyId },
  });
});

router.post("/active-company", requireAuth, async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const companyId = normalizeCompanyId(body.company_id);
  if (!companyId) return res.status(400).json({ ok: false, error: "INVALID_COMPANY" });
  const companies = Array.isArray(req.user?.companies) ? req.user.companies : [];
  const isSuper = req.user.group_name === "SuperAdmin";
  if (!isSuper && !companies.some((c) => Number(c.company_id) === companyId)) {
    return res.status(403).json({ ok: false, error: "COMPANY_NOT_ALLOWED" });
  }
  req.session.activeCompanyId = companyId;
  return res.json({ ok: true, active_company_id: companyId });
});

module.exports = router;

