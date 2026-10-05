#!/usr/bin/env node
/**
 * AR isolation guard: protected files must never reference proforma.
 * Exit non-zero on any hit.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PROTECTED = [
  "src/routes/receipts.js",
  "src/routes/collectionsDesk.js",
  "src/routes/collectionsAnalytics.js",
  "src/routes/creditControl.js",
  "src/routes/reconciliationDesk.js",
  "src/routes/glDesk.js",
  "src/routes/salesDesk.js",
  "src/services/creditControl.js",
  "src/services/tally/tallyXml.js",
  "src/services/tally/ledgerMap.js",
  "src/services/tally/salesVoucher.js",
  "src/services/tally/receiptVoucher.js",
  "src/routes/tallyExport.js",
];

// Client AR surfaces (relative to monorepo root)
const CLIENT_ROOT = path.resolve(__dirname, "../../client");
const CLIENT_PROTECTED = ["src/arDesk/ArDesk.jsx", "src/receipts/Receipts.jsx"];

const hits = [];

function scan(base, rel) {
  const full = path.join(base, rel);
  if (!fs.existsSync(full)) return;
  const text = fs.readFileSync(full, "utf8");
  if (/proforma/i.test(text)) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (/proforma/i.test(line)) hits.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
}

for (const rel of PROTECTED) scan(ROOT, rel);
for (const rel of CLIENT_PROTECTED) scan(CLIENT_ROOT, rel);

if (hits.length) {
  process.stderr.write(`AR isolation FAILED (${hits.length} hit(s)):\n${hits.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("AR isolation OK — no proforma references in protected AR/Tally surfaces.\n");
process.exit(0);
