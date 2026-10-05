#!/usr/bin/env node
/**
 * Verify job/machine-serial normalization against every real variant observed in
 * the Service Master, the service visit log, and the Tally invoice bible.
 *
 *   node scripts/verify-job-number-normalization.js
 *
 * Exits non-zero on any mismatch so it can gate an import run.
 */
const { parseJobRef } = require("../src/services/jobNumber");

// [raw input, expected canonical key, expected company]
const CASES = [
  // Service Master padding variants vs service log vs invoice bible
  ["M-028", "M0028", "AT"],
  ["M-30", "M0030", "AT"],
  ["M0139", "M0139", "AT"],
  ["N01", "N0001", "AI"],
  ["N010", "N0010", "AI"],
  ["N047", "N0047", "AI"],
  ["ID07", "ID0007", "AI"],
  ["ID010", "ID0010", "AI"],
  ["ID006", "ID0006", "AI"],
  // letter-variant machines sharing one number
  ["N02 B", "N0002", "AI"],
  ["ID04 a", "ID0004", "AI"],
  ["ID04 b", "ID0004", "AI"],
  // typos
  ["N 04", "N0004", "AI"],
  ["N  04", "N0004", "AI"],
  ["IDO25", "ID0025", "AI"],
  ["NO61", "N0061", "AI"],
  ["n071", "N0071", "AI"],
  // medical prefixes
  ["AT-MX-01", "MX0001", "AT"],
  ["MX-24", "MX0024", "AT"],
  ["ASP 01", "ASP0001", "AT"],
  ["ASP05", "ASP0005", "AT"],
  ["AS01", "AS0001", "AT"],
  ["GS01", "GS0001", "AI"],
  // install slip + machine serial mashed together
  ["IS0118N086", "N0086", "AI"],
  ["IS00114N075", "N0075", "AI"],
  ["IS0042N09", "N0009", "AI"],
  ["IS0001N01", "N0001", "AI"],
  ["IS0100ID001", "ID0001", "AI"],
  ["IS00N076", "N0076", "AI"],
  // install slips with no machine identified
  ["IS0096", null, null],
  ["IS0040", null, null],
  ["IS0051", null, null],
  // multi-machine cells
  ["N046,N047", "N0046", "AI"],
  ["N095,N096,N097", "N0095", "AI"],
  ["N081,ID012", "N0081", "AI"],
  ["ID02/M-165", "ID0002", null],
  ["ID01/M0139", "ID0001", null],
  ["N043/N074", "N0043", "AI"],
  // junk
  ["1993", null, null],
  ["305", null, null],
  ["Map 1 Enkai", null, null],
  ["RAJPIPLA", null, null],
  ["", null, null],
];

function main() {
  let pass = 0;
  const failures = [];

  console.log("input".padEnd(18), "key".padEnd(9), "co".padEnd(6), "slip".padEnd(8), "issues");
  console.log("-".repeat(92));
  for (const [input, wantKey, wantCompany] of CASES) {
    const parsed = parseJobRef(input);
    const ok = parsed.primary === wantKey && parsed.company === wantCompany;
    if (ok) pass += 1;
    else failures.push({ input, got: parsed.primary, gotCompany: parsed.company, wantKey, wantCompany });
    console.log(
      (ok ? "  " : "X ") + JSON.stringify(input).padEnd(16),
      String(parsed.primary || "-").padEnd(9),
      String(parsed.company || "-").padEnd(6),
      String(parsed.installSlip || "-").padEnd(8),
      parsed.issues.join(",")
    );
  }
  console.log("-".repeat(92));
  console.log(`pass ${pass}/${CASES.length}`);

  if (failures.length) {
    console.error("\nFAILURES:");
    for (const f of failures) {
      console.error(`  ${JSON.stringify(f.input)} -> ${f.got}/${f.gotCompany}, expected ${f.wantKey}/${f.wantCompany}`);
    }
    process.exitCode = 1;
    return;
  }

  // multi-machine cells must expand to every machine, and a cell that spans
  // companies must refuse to assert one.
  const mixed = parseJobRef("ID02/M-165");
  if (mixed.refs.length !== 2 || mixed.company !== null) {
    console.error("\nFAILURE: ID02/M-165 must expand to 2 refs across companies with no single owner");
    process.exitCode = 1;
    return;
  }
  const five = parseJobRef("N090,N091,N092,N093,N094");
  if (five.refs.length !== 5) {
    console.error("\nFAILURE: 5-machine cell did not expand to 5 refs");
    process.exitCode = 1;
    return;
  }
  console.log("multi-ref expansion ok");
}

main();
