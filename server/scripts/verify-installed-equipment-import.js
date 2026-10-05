#!/usr/bin/env node
/**
 * Checks how import-installed-equipment.js folds a reviewer's CONFIRM_ columns over its
 * own resolution. A mistake here is quiet and expensive: it would either ignore a
 * correction someone made by hand, or record a correction nobody made.
 */

const { applyConfirmations, isoDate } = require("./import-installed-equipment");

const CASES = [
  [
    "no confirmations: the script's own resolution stands",
    { serial_number: "N0045", customer_code: "C12491", item_code: "nGenx004" },
    { serialNumber: "N0045", customerCode: "C12491", itemCode: "nGenx004", confirmed: [] },
  ],
  [
    "a differing confirmation wins and is recorded",
    { serial_number: "N0045", customer_code: "C12491", item_code: "nGenx004", CONFIRM_item_code: "nGenx005" },
    { serialNumber: "N0045", customerCode: "C12491", itemCode: "nGenx005", confirmed: ["item_code"] },
  ],
  [
    "a confirmation agreeing but for case and spacing is not a correction",
    { serial_number: "N0045", customer_code: "C12491", item_code: "nGEN 10 P", CONFIRM_item_code: "ngen10p" },
    { serialNumber: "N0045", customerCode: "C12491", itemCode: "ngen10p", confirmed: [] },
  ],
  [
    "a confirmation fills what the script could not resolve",
    { serial_number: "N0018", customer_code: "", item_code: "", CONFIRM_customer_code: "C129", CONFIRM_item_code: "nGEN 09" },
    { serialNumber: "N0018", customerCode: "C129", itemCode: "nGEN 09", confirmed: ["customer_code", "item_code"] },
  ],
  [
    "every field can be overridden at once",
    {
      serial_number: "N0002B", customer_code: "C111", item_code: "nGEN001UH",
      CONFIRM_serial_number: "N0002", CONFIRM_customer_code: "C222", CONFIRM_item_code: "nGEN002UH",
    },
    {
      serialNumber: "N0002", customerCode: "C222", itemCode: "nGEN002UH",
      confirmed: ["serial_number", "customer_code", "item_code"],
    },
  ],
  [
    "surrounding whitespace in a confirmation is trimmed, not treated as a change",
    { serial_number: "N0045", customer_code: "C12491", item_code: "nGenx004", CONFIRM_customer_code: "  C12491  " },
    { serialNumber: "N0045", customerCode: "C12491", itemCode: "nGenx004", confirmed: [] },
  ],
];

const DATE_CASES = [
  ["2024-03-12", "2024-03-12"],
  ["", null],
  ["12/03/2024", null],
  ["2024-3-1", null],
  ["not a date", null],
  [undefined, null],
];

function main() {
  let pass = 0;
  const failures = [];

  for (const [name, row, want] of CASES) {
    const got = applyConfirmations(row);
    const diffs = [];
    for (const key of ["serialNumber", "customerCode", "itemCode"]) {
      if (got[key] !== want[key]) diffs.push(`${key}: got "${got[key]}", want "${want[key]}"`);
    }
    if (got.confirmed.sort().join(",") !== want.confirmed.slice().sort().join(",")) {
      diffs.push(`confirmed: got [${got.confirmed}], want [${want.confirmed}]`);
    }
    if (!diffs.length) { pass += 1; continue; }
    failures.push({ name, diffs });
  }

  for (const [input, want] of DATE_CASES) {
    const got = isoDate(input);
    if (got === want) { pass += 1; continue; }
    failures.push({ name: `isoDate(${JSON.stringify(input)})`, diffs: [`got ${got}, want ${want}`] });
  }

  for (const f of failures) {
    console.log(`FAIL ${f.name}`);
    f.diffs.forEach((d) => console.log(`       ${d}`));
  }
  console.log(`pass ${pass}/${CASES.length + DATE_CASES.length}`);
  if (failures.length) process.exitCode = 1;
}

main();
