#!/usr/bin/env node
/**
 * Checks the legacy/current classification used by import-legacy-ai-generator-products.js
 * against real codes from the Clan AI item master, including the awkward ones: the 14
 * whitespace-twin SKUs, the CP/ST/DX accessories that share the nGEN stem, and the nGenx
 * padding switch. No legacy->current successor is asserted, so none is tested.
 */

const {
  familyFromCode,
  moduleRoleFor,
  variantFor,
  isLegacyCode,
  isCustomOneOff,
  isSpareRow,
  isActiveRow,
} = require("./import-legacy-ai-generator-products");

// code, group, expected { family, variant, legacy, module }
const CASES = [
  // --- legacy generators. Group is deliberately Clan's *mis-filed* one for the P codes,
  //     proving family comes from the code rather than the group.
  ["nGEN 10",     "nGen Nitrogen Generator",           { family: "NGEN", variant: "STD", legacy: true, module: "generator"}],
  ["nGEN 10 P",   "IDOS Oxygen Generator Package",     { family: "NGEN", variant: "P",   legacy: true, module: "generator"}],
  ["nGEN 10 P B", "nGen Nitrogen Generator Package",   { family: "NGEN", variant: "P",   legacy: true, module: "generator"}],
  ["nGEN 01 B",   "nGen Nitrogen Generator Package",   { family: "NGEN", variant: "STD", legacy: true, module: "generator"}],
  ["nGEN 30 P",   "IDOS Oxygen Generator Package",     { family: "NGEN", variant: "P",   legacy: true, module: "generator"}],
  ["nGen 40P",    "IDOS Oxygen Generator Package",     { family: "NGEN", variant: "P",   legacy: true, module: "generator"}],

  // --- accessories sharing the nGEN stem: never a purity variant, never "legacy"
  ["nGEN 01 CP",  "nGen Air Package",                  { family: "NGEN", variant: null,  legacy: false, module: "air_system"}],
  ["nGEN 01 ST",  "nGen Gas Storage",                  { family: "NGEN", variant: null,  legacy: false, module: "gas_storage"}],
  ["nGEN 04 DX",  "Deoxo Unit",                        { family: "NGEN", variant: null,  legacy: false, module: "generator"}],
  ["nGEN 04 DXC", "Deoxo with Cracker",                { family: "NGEN", variant: null,  legacy: false, module: "generator"}],

  // --- current range
  ["nGEN010UH",   "nGen Nitrogen Generator Ultra Purity", { family: "NGEN", variant: "UH", legacy: false, module: "generator"}],
  ["nGEN030SH",   "nGen Nitrogen Generator High Purity",  { family: "NGEN", variant: "SH", legacy: false, module: "generator"}],
  ["nGEN010HF",   "nGen Nitrogen Generator High Flow",    { family: "NGEN", variant: "HF", legacy: false, module: "generator"}],
  ["nGEN002UH M", "nGen Nitrogen Generator Ultra Purity", { family: "NGEN", variant: "UH", legacy: false, module: "generator"}],

  // --- nGenx: spaced is legacy, zero-padded is current
  ["nGenx 04",    "nGenx Nitrogen Generator",          { family: "NGENX", variant: "STD", legacy: true,  module: "generator"}],
  ["nGenx 01",    "nGenx Nitrogen Generator",          { family: "NGENX", variant: "STD", legacy: true,  module: "generator"}],
  ["nGenx004",    "nGenx Nitrogen Generator",          { family: "NGENX", variant: null,  legacy: false, module: "generator"}],

  // --- IDOS / MedO: the C marker must end the code
  ["IDOS 2C",     "IDOS C",                            { family: "IDOS_C", variant: null, legacy: false, module: "generator"}],
  ["IDOS 01 CP",  "IDOS Air Package",                  { family: "IDOS",   variant: null, legacy: false, module: "air_system"}],
  ["IDOS 25 ST",  "IDOS Gas Storage",                  { family: "IDOS",   variant: null, legacy: false, module: "gas_storage"}],
  ["IDOS 25 B",   "IDOS Oxygen Generator",             { family: "IDOS",   variant: null, legacy: false, module: "generator"}],

  // --- a size with no counterpart in the current range at all
  ["nGEN 145",    "nGen Nitrogen Generator",           { family: "NGEN", variant: "STD", legacy: true, module: "generator"}],
];

/** code, group, active -> { custom, spare, active } */
const ROW_CASES = [
  // The single bespoke build: current-era, so not legacy, but must not be quotable.
  ["nGEN002UH M", "nGen Nitrogen Generator Ultra Purity", "YES", { custom: true,  spare: false, active: true }],
  ["nGEN002UH",   "nGen Nitrogen Generator Ultra Purity", "YES", { custom: false, spare: false, active: true }],

  ["ASH566",      "Spares",                              "YES", { custom: false, spare: true,  active: true }],
  ["AONAF025A",   "Spares",                              "NO",  { custom: false, spare: true,  active: false }],
  // Clan mis-types this group on a single item; it is still a service item.
  ["ASP-nGEN 70 P B", "Services1",                       "YES", { custom: false, spare: true,  active: true }],
  // A generator is plant, not a spare, whatever its group says.
  ["nGEN 10 P",   "Spares",                              "YES", { custom: false, spare: false, active: true }],
  // Retired IDOS/MedO machines predate the nGEN rename, so isLegacyCode does not see them.
  // Only Clan's own Active flag marks them as withdrawn, and two customers own an IDOS 09.
  ["IDOS 09",     "IDOS Oxygen Generator Package",       "NO",  { custom: false, spare: false, active: false }],
  ["IDOS 45 B",   "IDOS Oxygen Generator",               "YES", { custom: false, spare: false, active: true }],
];

function main() {
  let pass = 0;
  const failures = [];

  for (const [code, group, want] of CASES) {
    const got = {
      family: familyFromCode(code, group),
      variant: variantFor(code),
      legacy: isLegacyCode(code),
      module: moduleRoleFor(code, group),
    };
    const diffs = Object.keys(want).filter((k) => String(got[k]) !== String(want[k]));
    if (!diffs.length) { pass += 1; continue; }
    failures.push({ code, diffs: diffs.map((k) => `${k}: got ${got[k]}, want ${want[k]}`) });
  }

  for (const [code, group, active, want] of ROW_CASES) {
    const row = { "Item Code": code, Group: group, Active: active };
    const got = { custom: isCustomOneOff(code), spare: isSpareRow(row), active: isActiveRow(row) };
    const diffs = Object.keys(want).filter((k) => String(got[k]) !== String(want[k]));
    if (!diffs.length) { pass += 1; continue; }
    failures.push({ code, diffs: diffs.map((k) => `${k}: got ${got[k]}, want ${want[k]}`) });
  }

  for (const f of failures) {
    console.log(`FAIL ${f.code}`);
    f.diffs.forEach((d) => console.log(`       ${d}`));
  }
  console.log(`pass ${pass}/${CASES.length + ROW_CASES.length}`);
  if (failures.length) process.exitCode = 1;
}

main();
