const { isMailConfigured, getMailerConfig } = require("./mailer");

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

function inferGoogleMailCallbackUrl() {
  const base = normalizeBaseUrl(process.env.APP_BASE_URL || "");
  if (!base) return "";
  return `${base}/mail-accounts/google/callback`;
}

function isRootCallbackUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.pathname === "/" && !u.search && !u.hash;
  } catch {
    return false;
  }
}

function getGoogleMailConfig() {
  const explicit = String(process.env.MAIL_GOOGLE_CALLBACK_URL || "").trim();
  const inferred = inferGoogleMailCallbackUrl();
  const callbackUrl = isRootCallbackUrl(explicit) && inferred ? inferred : explicit || inferred;
  return {
    clientId: String(process.env.MAIL_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.MAIL_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || "").trim(),
    callbackUrl,
  };
}

function isGoogleMailConfigured() {
  const cfg = getGoogleMailConfig();
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.callbackUrl);
}

async function getDistributorIdForUser(client, userId) {
  const id = Number(userId);
  if (!Number.isFinite(id)) return null;
  const r = await client.query(`select distributor_id from user_distributor_links where user_id = $1 limit 1`, [id]);
  return r.rows[0]?.distributor_id || null;
}

async function getMailAccountByOwner(client, { ownerType, userId, distributorId, provider = "google" }) {
  if (ownerType === "user" && Number.isFinite(Number(userId))) {
    const r = await client.query(
      `
        select *
        from mail_accounts
        where owner_type = 'user' and user_id = $1 and provider = $2 and is_active = true
        limit 1
      `,
      [Number(userId), provider]
    );
    return r.rows[0] || null;
  }

  if (ownerType === "distributor" && Number.isFinite(Number(distributorId))) {
    const r = await client.query(
      `
        select *
        from mail_accounts
        where owner_type = 'distributor' and distributor_id = $1 and provider = $2 and is_active = true
        limit 1
      `,
      [Number(distributorId), provider]
    );
    return r.rows[0] || null;
  }

  return null;
}

function summarizeAccount(account) {
  if (!account) {
    return {
      connected: false,
      provider: "google",
      mailbox_email: "",
      display_name: "",
      owner_type: null,
    };
  }

  return {
    connected: true,
    provider: account.provider,
    mailbox_email: account.mailbox_email || "",
    display_name: account.display_name || "",
    owner_type: account.owner_type,
    last_used_at: account.last_used_at || null,
    updated_at: account.updated_at || null,
  };
}

async function upsertMailAccount(
  client,
  { ownerType, userId, distributorId, provider = "google", mailboxEmail, displayName, refreshToken, accessToken, scopeText, connectedBy }
) {
  if (ownerType === "user" && Number.isFinite(Number(userId))) {
    const r = await client.query(
      `
        insert into mail_accounts (
          owner_type,
          user_id,
          provider,
          mailbox_email,
          display_name,
          refresh_token,
          access_token,
          scope_text,
          connected_by,
          last_verified_at,
          updated_at,
          is_active
        )
        values ('user',$1,$2,$3,$4,$5,$6,$7,$8,now(),now(),true)
        on conflict (user_id, provider) do update set
          mailbox_email = excluded.mailbox_email,
          display_name = excluded.display_name,
          refresh_token = excluded.refresh_token,
          access_token = excluded.access_token,
          scope_text = excluded.scope_text,
          connected_by = excluded.connected_by,
          last_verified_at = now(),
          updated_at = now(),
          is_active = true
        returning *
      `,
      [Number(userId), provider, mailboxEmail, displayName || null, refreshToken, accessToken || null, scopeText || null, connectedBy || null]
    );
    return r.rows[0] || null;
  }

  if (ownerType === "distributor" && Number.isFinite(Number(distributorId))) {
    const r = await client.query(
      `
        insert into mail_accounts (
          owner_type,
          distributor_id,
          provider,
          mailbox_email,
          display_name,
          refresh_token,
          access_token,
          scope_text,
          connected_by,
          last_verified_at,
          updated_at,
          is_active
        )
        values ('distributor',$1,$2,$3,$4,$5,$6,$7,$8,now(),now(),true)
        on conflict (distributor_id, provider) do update set
          mailbox_email = excluded.mailbox_email,
          display_name = excluded.display_name,
          refresh_token = excluded.refresh_token,
          access_token = excluded.access_token,
          scope_text = excluded.scope_text,
          connected_by = excluded.connected_by,
          last_verified_at = now(),
          updated_at = now(),
          is_active = true
        returning *
      `,
      [Number(distributorId), provider, mailboxEmail, displayName || null, refreshToken, accessToken || null, scopeText || null, connectedBy || null]
    );
    return r.rows[0] || null;
  }

  return null;
}

async function deactivateMailAccount(client, { ownerType, userId, distributorId, provider = "google" }) {
  if (ownerType === "user" && Number.isFinite(Number(userId))) {
    await client.query(
      `update mail_accounts set is_active = false, updated_at = now() where owner_type = 'user' and user_id = $1 and provider = $2`,
      [Number(userId), provider]
    );
    return;
  }

  if (ownerType === "distributor" && Number.isFinite(Number(distributorId))) {
    await client.query(
      `update mail_accounts set is_active = false, updated_at = now() where owner_type = 'distributor' and distributor_id = $1 and provider = $2`,
      [Number(distributorId), provider]
    );
  }
}

async function markMailAccountUsed(client, accountId) {
  const id = Number(accountId);
  if (!Number.isFinite(id)) return;
  await client.query(`update mail_accounts set last_used_at = now(), updated_at = now() where id = $1`, [id]);
}

async function resolveEffectiveMailSource(client, { userId, userGroupName, quoteDistributorId }) {
  const userAccount = await getMailAccountByOwner(client, { ownerType: "user", userId });
  if (userAccount) {
    return {
      type: "user_oauth",
      provider: userAccount.provider,
      email: userAccount.mailbox_email,
      displayName: userAccount.display_name || userAccount.mailbox_email,
      account: userAccount,
    };
  }

  const actorDistributorId = await getDistributorIdForUser(client, userId);
  const distributorId =
    Number.isFinite(Number(quoteDistributorId)) && Number(quoteDistributorId) > 0
      ? Number(quoteDistributorId)
      : actorDistributorId;

  if ((userGroupName === "Distributor" || Number.isFinite(Number(distributorId))) && Number.isFinite(Number(distributorId))) {
    const distributorAccount = await getMailAccountByOwner(client, {
      ownerType: "distributor",
      distributorId,
    });
    if (distributorAccount) {
      return {
        type: "distributor_oauth",
        provider: distributorAccount.provider,
        email: distributorAccount.mailbox_email,
        displayName: distributorAccount.display_name || distributorAccount.mailbox_email,
        account: distributorAccount,
      };
    }
  }

  if (isMailConfigured()) {
    const cfg = getMailerConfig();
    return {
      type: "company_default",
      provider: "smtp",
      email: cfg.fromEmail,
      displayName: cfg.fromName || cfg.fromEmail,
      account: null,
    };
  }

  return {
    type: "none",
    provider: null,
    email: "",
    displayName: "",
    account: null,
  };
}

async function getMailBootstrap(client, { userId, userGroupName, quoteDistributorId }) {
  const distributorId = await getDistributorIdForUser(client, userId);
  const userAccount = await getMailAccountByOwner(client, { ownerType: "user", userId });
  const distributorAccount =
    Number.isFinite(Number(distributorId)) && (userGroupName === "Distributor" || Number.isFinite(Number(quoteDistributorId)))
      ? await getMailAccountByOwner(client, { ownerType: "distributor", distributorId: quoteDistributorId || distributorId })
      : null;
  const effectiveSource = await resolveEffectiveMailSource(client, { userId, userGroupName, quoteDistributorId });

  return {
    google_oauth_available: isGoogleMailConfigured(),
    company_default_available: isMailConfigured(),
    user_account: summarizeAccount(userAccount),
    distributor_shared_account: summarizeAccount(distributorAccount),
    effective_sender: {
      source: effectiveSource.type,
      provider: effectiveSource.provider,
      email: effectiveSource.email,
      display_name: effectiveSource.displayName,
      connected: effectiveSource.type !== "none",
    },
  };
}

module.exports = {
  deactivateMailAccount,
  getDistributorIdForUser,
  getGoogleMailConfig,
  getMailAccountByOwner,
  getMailBootstrap,
  isGoogleMailConfigured,
  markMailAccountUsed,
  resolveEffectiveMailSource,
  summarizeAccount,
  upsertMailAccount,
};
