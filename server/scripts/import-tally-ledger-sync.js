const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { pool } = require("../src/db/pool");
const { runTallyLedgerSync } = require("../src/services/tallyLedgerSync");

function parseArgs(argv) {
  const out = {
    xml: path.resolve(__dirname, "../../Transactions (1).xml"),
    xmlExplicit: false,
    billwise: null,
    company: "AI",
    apply: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") out.apply = true;
    else if (token === "--dry-run") out.apply = false;
    else if (token.startsWith("--xml=")) {
      out.xml = path.resolve(token.slice("--xml=".length));
      out.xmlExplicit = true;
    } else if (token === "--xml" && argv[i + 1]) {
      out.xml = path.resolve(argv[++i]);
      out.xmlExplicit = true;
    } else if (token.startsWith("--billwise=")) {
      out.billwise = path.resolve(token.slice("--billwise=".length));
    } else if (token === "--billwise" && argv[i + 1]) {
      out.billwise = path.resolve(argv[++i]);
    } else if (token.startsWith("--company=")) out.company = token.slice("--company=".length);
    else if (token === "--company" && argv[i + 1]) out.company = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  // Prefer explicit --billwise, else explicit --xml, else Transactions (1).xml
  let preferred = args.xml;
  if (args.billwise) preferred = args.billwise;
  if (!fs.existsSync(preferred)) {
    console.error(`XML not found: ${preferred}`);
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    if (args.apply) await client.query("begin");
    const summary = await runTallyLedgerSync(client, {
      companyIdOrCode: args.company,
      xmlBuffer: fs.readFileSync(preferred),
      fileName: path.basename(preferred),
      apply: args.apply,
    });
    summary.xml_file = path.basename(preferred);
    if (args.apply) await client.query("commit");
    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    if (args.apply) {
      try {
        await client.query("rollback");
      } catch (_e) {
        /* ignore */
      }
    }
    console.error(err?.stack || err?.message || err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main();
}
