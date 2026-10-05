const assert = require("assert");
const { normalizePhoneDigits, phonesMatch, phoneMatchPatterns } = require("../src/services/leadPhone");

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (err) {
    process.stderr.write(`fail - ${name}\n${err?.stack || err}\n`);
    process.exitCode = 1;
  }
}

test("normalize strips non-digits", () => {
  assert.strictEqual(normalizePhoneDigits("+91 98765-43210"), "9876543210");
});

test("normalize keeps short local numbers", () => {
  assert.strictEqual(normalizePhoneDigits("0124-4567890"), "01244567890".slice(-10));
});

test("empty phone normalizes to empty", () => {
  assert.strictEqual(normalizePhoneDigits("  "), "");
  assert.strictEqual(normalizePhoneDigits(null), "");
});

test("phonesMatch equates formatted variants", () => {
  assert.strictEqual(phonesMatch("+91-9876543210", "9876543210"), true);
  assert.strictEqual(phonesMatch("9876543210", "98765 43211"), false);
});

test("phoneMatchPatterns rejects short phones", () => {
  assert.strictEqual(phoneMatchPatterns("12345"), null);
  assert.deepStrictEqual(phoneMatchPatterns("9876543210"), {
    digits: "9876543210",
    likeSuffix: "%9876543210",
  });
});

test("unique vs duplicate decision helper", () => {
  const existing = ["+91 9876543210", "011-23456789"];
  const isDup = (incoming) => existing.some((row) => phonesMatch(row, incoming));
  assert.strictEqual(isDup("9876543210"), true);
  assert.strictEqual(isDup("9999999999"), false);
});

if (!process.exitCode) process.stdout.write("All lead phone dedupe tests passed.\n");
