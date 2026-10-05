/**
 * End-to-end legacy commercial hygiene:
 *  1) QuotationReport → Clean_AutoClosed (+ test archive)
 *  2) LeadEntryReport → Clean_Aligned against cleaned quotes (LeadNo bridge)
 *
 * Usage:
 *   node scripts/process_legacy_hygiene_pipeline.js
 *   node scripts/process_legacy_hygiene_pipeline.js --apply --company-id=2
 */

const path = require("path");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
  const passthrough = [];
  let apply = false;
  for (const token of argv) {
    if (token === "--apply") apply = true;
    passthrough.push(token);
  }
  return { apply, passthrough };
}

function run(scriptRel, args) {
  const script = path.resolve(__dirname, scriptRel);
  console.log(`\n>>> node ${scriptRel} ${args.join(" ")}\n`);
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function main() {
  const { passthrough } = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, "../..");

  run("process_quotation_report_hygiene.js", [
    `--file=${path.join(repoRoot, "QuotationReport_07-Sep-2026.xlsx")}`,
    ...passthrough.filter((t) => t === "--apply" || t.startsWith("--company-id") || t.startsWith("--cutoff") || t.startsWith("--batch=") || t === "--batch"),
  ]);

  run("process_lead_entry_report_hygiene.js", [
    `--leads=${path.join(repoRoot, "LeadEntryReport_07-Sep-2026.xlsx")}`,
    `--quotes=${path.join(repoRoot, "QuotationReport_Clean_AutoClosed.xlsx")}`,
    `--test-archive=${path.join(repoRoot, "QuotationReport_TestArchive.xlsx")}`,
    ...passthrough.filter((t) => t === "--apply" || t.startsWith("--company-id") || t.startsWith("--batch=") || t === "--batch"),
  ]);

  console.log("\nLegacy hygiene pipeline complete.");
}

main();
