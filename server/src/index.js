const path = require("path");
const fs = require("fs");
// Load server/.env then optional server/.env.local (local overrides; never upload .env.local).
// When .env.local exists, file values must win over inherited Windows/shell env (otherwise a
// stale GOOGLE_CLIENT_ID can cause redirect_uri_mismatch against the wrong OAuth client).
const envPath = path.join(__dirname, "../.env");
const localEnvPath = path.join(__dirname, "../.env.local");
require("dotenv").config({ path: envPath });
if (fs.existsSync(localEnvPath)) {
  require("dotenv").config({ path: envPath, override: true });
  require("dotenv").config({ path: localEnvPath, override: true });
}

const { createApp } = require("./app");
const { pool } = require("./db/pool");
const { startImapInboundIngest } = require("./services/imapInboundIngest");
const { startInboundLeadReviewWorker } = require("./services/inboundLeadReview");
const { startDormancyWorker } = require("./services/dormancyBrevo");
const { registerDefaultCommissioningListeners } = require("./services/commissioningGates");
const { startAccessExpirySweep } = require("./services/accessProfiles");

const port = Number(process.env.PORT || 4000);

async function start() {
  await pool.query("select 1");
  registerDefaultCommissioningListeners();

  const app = createApp();

  app.listen(port, () => {
    process.stdout.write(`JOSH API listening on http://localhost:${port}\n`);
    try {
      const imap = startImapInboundIngest(pool);
      if (imap?.started) {
        process.stdout.write("[imap-ingest] ready — send a test mail to the configured inbox\n");
      }
    } catch (err) {
      process.stderr.write(`[imap-ingest] failed to start: ${err?.message || err}\n`);
    }
    try {
      startInboundLeadReviewWorker(pool);
    } catch (err) {
      process.stderr.write(`[inbound-gmail] failed to start: ${err?.message || err}\n`);
    }
    try {
      startAccessExpirySweep(pool);
    } catch (err) {
      process.stderr.write(`[access-v2] expiry sweep failed to start: ${err?.message || err}\n`);
    }
    try {
      const dormancy = startDormancyWorker(pool);
      if (dormancy?.started) {
        process.stdout.write(`[dormancy] scanner every ${dormancy.hours}h\n`);
      }
    } catch (err) {
      process.stderr.write(`[dormancy] failed to start: ${err?.message || err}\n`);
    }
  });
}

start().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
