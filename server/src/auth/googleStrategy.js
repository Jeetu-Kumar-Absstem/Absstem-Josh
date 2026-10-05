const GoogleStrategy = require("passport-google-oauth20").Strategy;
const { pool } = require("../db/pool");
const { loadUserContextByEmail, loadUserContextById } = require("./userContext");
const { sendMail } = require("../services/mailer");

function registerGoogleStrategy(passport) {
  passport.serializeUser((user, done) => done(null, user.id));

  passport.deserializeUser(async (id, done) => {
    try {
      const user = await loadUserContextById(pool, id);
      return done(null, user || false);
    } catch (err) {
      return done(err);
    }
  });

  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = (profile?.emails?.[0]?.value || "").toLowerCase();
          if (!email.endsWith("@absstem.com")) return done(null, false);

          const user = await loadUserContextByEmail(pool, email);
          if (!user) {
            const baseRes = await pool.query(
              `
                select
                  u.id,
                  u.is_active,
                  u.is_approved,
                  u.approval_requested_at
                from erp_users u
                where u.email = $1
                limit 1
              `,
              [email]
            );
            const existing = baseRes.rows[0] || null;
            if (!existing) {
              const groupRes = await pool.query(
                `select id from user_groups where group_name = 'Absstem' and is_active = true limit 1`
              );
              const roleRes = await pool.query(
                `select id from roles where role_key = 'sales_executive' and is_active = true limit 1`
              );
              const groupId = groupRes.rows[0]?.id;
              const roleId = roleRes.rows[0]?.id;
              if (groupId && roleId) {
                const fullName = String(profile?.displayName || "").trim() || email;
                const ins = await pool.query(
                  `
                    insert into erp_users (email, full_name, group_id, primary_role_id, is_active, is_approved, approval_requested_at, updated_at)
                    values ($1,$2,$3,$4,true,false,now(),now())
                    on conflict (email) do update set
                      full_name = coalesce(excluded.full_name, erp_users.full_name),
                      updated_at = now()
                    returning id
                  `,
                  [email, fullName, groupId, roleId]
                );
                const userId = ins.rows[0]?.id;
                if (userId) {
                  await pool.query(
                    `
                      insert into user_roles (user_id, role_id, is_primary)
                      values ($1,$2,true)
                      on conflict (user_id, role_id) do update set is_primary = true
                    `,
                    [userId, roleId]
                  );
                }
                await sendSuperAdminApprovalRequestMail({ email, fullName, roleKey: "sales_executive", groupName: "Absstem" }).catch(() => {});
              }
              return done(null, false);
            }

            if (existing.is_active === false) return done(null, false);

            if (existing.is_approved !== true) {
              const shouldSend =
                !existing.approval_requested_at ||
                Date.now() - new Date(existing.approval_requested_at).getTime() > 60 * 60 * 1000;
              if (shouldSend) {
                await pool.query(`update erp_users set approval_requested_at = now(), updated_at = now() where id = $1`, [existing.id]);
                await sendSuperAdminApprovalRequestMail({
                  email,
                  fullName: String(profile?.displayName || "").trim() || email,
                  roleKey: "sales_executive",
                  groupName: "Absstem",
                }).catch(() => {});
              }
              return done(null, false);
            }

            return done(null, false);
          }

          const googleUserId = String(profile?.id || "").trim() || null;
          await pool.query(
            `update erp_users set last_login_at = now(), google_user_id = coalesce($2, google_user_id), updated_at = now() where id = $1`,
            [user.id, googleUserId]
          );

          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );
}

async function sendSuperAdminApprovalRequestMail({ email, fullName, roleKey, groupName }) {
  const r = await pool.query(
    `
      select u.email
      from erp_users u
      join user_groups g on g.id = u.group_id
      where g.group_name = 'SuperAdmin'
        and u.is_active = true
        and coalesce(u.email, '') <> ''
      order by u.id asc
    `
  );
  const to = r.rows.map((row) => row.email).filter(Boolean);
  if (!to.length) return;

  const subject = `JOSH access request: ${email}`;
  const text = [
    "A new user attempted to sign in to JOSH and is pending approval.",
    "",
    `Name: ${fullName}`,
    `Email: ${email}`,
    `Requested Group: ${groupName}`,
    `Requested Role: ${roleKey}`,
    "",
    "Approve the user in User Master (set Approved = Yes), then assign rights in Rights Matrix.",
  ].join("\n");

  await sendMail({
    to,
    subject,
    text,
    html: text.replaceAll("\n", "<br/>"),
  });
}

module.exports = { registerGoogleStrategy };

