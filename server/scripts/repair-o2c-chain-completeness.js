#!/usr/bin/env node
/**
 * Complete O2C chain repairs for AI (after legacy SO + Tally import).
 *
 *   A) Allocate unallocated Tally receipts via Against Ref
 *   B) Link remaining invoices → sales orders
 *   C) Backfill SO lines + totals from linked invoice lines
 *
 * Dry-run:
 *   node scripts/repair-o2c-chain-completeness.js --company=AI
 *   node scripts/repair-o2c-chain-completeness.js --company=AI --steps=A,B
 *
 * Apply:
 *   node scripts/repair-o2c-chain-completeness.js --company=AI --apply
 *   node scripts/repair-o2c-chain-completeness.js --company=AI --steps=C --apply
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { pool } = require("../src/db/pool");
const { resolveCompanyId, runO2cRepairs } = require("../src/services/o2cChainRepair");

function parseArgs(argv) {
  const out = { apply: false, company: "AI", steps: ["A", "B", "C"] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") out.apply = true;
    if (token.startsWith("--company=")) out.company = token.slice("--company=".length).trim() || out.company;
    if (token === "--company" && argv[i + 1]) out.company = String(argv[++i]).trim() || out.company;
    if (token.startsWith("--steps=")) {
      out.steps = token
        .slice("--steps=".length)
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    }
    if (token === "--steps" && argv[i + 1]) {
      out.steps = String(argv[++i])
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await pool.connect();
  try {
    const company = await resolveCompanyId(client, args.company);
    if (!company) throw new Error(`Company not found: ${args.company}`);

    console.log(
      JSON.stringify(
        {
          mode: args.apply ? "APPLY" : "DRY_RUN",
          company_id: company.id,
          company_code: company.company_code,
          steps: args.steps,
        },
        null,
        2
      )
    );

    if (args.apply) await client.query("begin");
    const report = await runO2cRepairs(client, {
      companyId: company.id,
      apply: args.apply,
      steps: args.steps,
    });
    if (args.apply) await client.query("commit");

    console.log(JSON.stringify({ ok: true, ...report }, null, 2));
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      /* ignore */
    }
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
