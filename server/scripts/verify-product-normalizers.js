#!/usr/bin/env node
/**
 * The family / module / variant normalizers in productMaster.js are reached with a blank
 * value by any import of a product that is not plant -- a spare has no family. They used
 * to call a string method on norm()'s null return and throw, which only showed up on a
 * real write, never in a dry run. These cases keep that path honest.
 */

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.resolve(__dirname, "../src/services/productMaster.js"), "utf8");
const grab = (name) => {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`could not locate ${name} in productMaster.js`);
  return m[0];
};

const { normalizeFamilyKey, normalizeModuleRole, normalizeVariantKey } = new Function(
  `${grab("norm")}\n${grab("normalizeFamilyKey")}\n${grab("normalizeModuleRole")}\n${grab("normalizeVariantKey")}\n` +
    "return { normalizeFamilyKey, normalizeModuleRole, normalizeVariantKey };"
)();

const BLANKS = [null, undefined, "", "   ", "\t"];
const CASES = [
  // A blank must come back as null rather than throwing: spares legitimately have none.
  ...BLANKS.flatMap((v) => [
    ["normalizeFamilyKey", normalizeFamilyKey, v, null],
    ["normalizeModuleRole", normalizeModuleRole, v, null],
    ["normalizeVariantKey", normalizeVariantKey, v, null],
  ]),

  ["normalizeFamilyKey", normalizeFamilyKey, "NGEN", "NGEN"],
  ["normalizeFamilyKey", normalizeFamilyKey, "ngenx", "NGENX"],
  ["normalizeFamilyKey", normalizeFamilyKey, "idos c", "IDOS_C"],
  ["normalizeFamilyKey", normalizeFamilyKey, "SHIELD", "SHIELD"],
  ["normalizeFamilyKey", normalizeFamilyKey, "not a family", null],

  ["normalizeModuleRole", normalizeModuleRole, "generator", "generator"],
  ["normalizeModuleRole", normalizeModuleRole, "spare", "spare"],
  ["normalizeModuleRole", normalizeModuleRole, "Compressed Air", "air_system"],
  ["normalizeModuleRole", normalizeModuleRole, "gas-storage", "gas_storage"],

  ["normalizeVariantKey", normalizeVariantKey, "UH", "UH"],
  ["normalizeVariantKey", normalizeVariantKey, "SH", "SH"],
  ["normalizeVariantKey", normalizeVariantKey, "HF", "HF"],
  // Legacy purity grades, retired by the 12-Mar-2025 rename but still needed for history.
  ["normalizeVariantKey", normalizeVariantKey, "P", "P"],
  ["normalizeVariantKey", normalizeVariantKey, "STD", "STD"],
  ["normalizeVariantKey", normalizeVariantKey, "standard", "STD"],
  ["normalizeVariantKey", normalizeVariantKey, "XX", null],
];

let pass = 0;
const failures = [];
for (const [name, fn, input, want] of CASES) {
  let got;
  try {
    got = fn(input);
  } catch (err) {
    failures.push(`${name}(${JSON.stringify(input)}) threw ${err.message}`);
    continue;
  }
  if (got === want) { pass += 1; continue; }
  failures.push(`${name}(${JSON.stringify(input)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

failures.forEach((f) => console.log(`FAIL ${f}`));
console.log(`pass ${pass}/${CASES.length}`);
if (failures.length) process.exitCode = 1;
