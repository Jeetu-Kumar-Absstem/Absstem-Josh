const GoogleStrategy = require("passport-google-oauth20").Strategy;
const { getGoogleMailConfig } = require("../services/mailAccounts");

function registerGoogleMailStrategy(passport) {
  const cfg = getGoogleMailConfig();
  if (!cfg.clientId || !cfg.clientSecret) return;

  const inboundCallbackUrl = String(process.env.INBOUND_MAIL_GOOGLE_CALLBACK_URL || "").trim();

  const verify = async (_req, accessToken, refreshToken, profile, done) => {
    try {
      const email = (profile?.emails?.[0]?.value || "").trim().toLowerCase();
      if (!email) return done(null, false);

      return done(null, {
        provider: "google",
        mailboxEmail: email,
        displayName: profile?.displayName || email,
        accessToken: accessToken || null,
        refreshToken: refreshToken || null,
      });
    } catch (err) {
      return done(err);
    }
  };

  if (cfg.callbackUrl) {
    passport.use(
      "google-mail",
      new GoogleStrategy(
        {
          clientID: cfg.clientId,
          clientSecret: cfg.clientSecret,
          callbackURL: cfg.callbackUrl,
          passReqToCallback: true,
        },
        verify
      )
    );
  }

  if (inboundCallbackUrl) {
    passport.use(
      "google-inbound-mail",
      new GoogleStrategy(
        {
          clientID: cfg.clientId,
          clientSecret: cfg.clientSecret,
          callbackURL: inboundCallbackUrl,
          passReqToCallback: true,
        },
        verify
      )
    );
  }
}

module.exports = { registerGoogleMailStrategy };
