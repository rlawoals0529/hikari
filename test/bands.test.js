const { test } = require("node:test");
const assert = require("node:assert");
const { logBands, smooth, bassLevel } = require("../src/lib/bands.js");

const flat = (n, v = 128) => new Uint8Array(n).fill(v);

test("returns the requested number of bands", () => {
  assert.strictEqual(logBands(flat(512), 24).length, 24);
});

test("a flat spectrum gives roughly equal bands", () => {
  for (const b of logBands(flat(512), 12)) assert.ok(Math.abs(b - 128 / 255) < 0.02);
});

test("silence is zero, not noise", () => {
  assert.ok(logBands(flat(512, 0), 8).every((b) => b === 0));
});

test("every band owns at least one bin on a small FFT", () => {
  // With few bins the low bands round to the same index. Without the guard they read as
  // silence, which looks like broken bass rather than a small transform.
  const out = logBands(flat(32), 24);
  assert.strictEqual(out.length, 24);
  assert.ok(out.every((b) => b > 0), "a band collapsed to zero on a flat spectrum");
});

test("energy lands in a high band when the frequency is high", () => {
  const bins = new Uint8Array(512);
  bins[128] = 255; // ~6 kHz at a 48 kHz rate over 512 bins
  const out = logBands(bins, 8, 48000);
  assert.ok(out.indexOf(Math.max(...out)) >= 5);
});

test("energy lands in a low band when the frequency is low", () => {
  const bins = new Uint8Array(512);
  bins[1] = 255; // ~47 Hz
  const out = logBands(bins, 8, 48000);
  assert.ok(out.indexOf(Math.max(...out)) <= 2);
});

test("no bins gives zeros rather than NaN", () => {
  assert.ok(logBands(new Uint8Array(0), 6).every((b) => b === 0));
});

test("zero bands is empty, not a crash", () => {
  assert.deepStrictEqual(logBands(flat(64), 0), []);
});

test("smoothing rises faster than it falls", () => {
  const up = smooth([0, 0], [1, 1])[0];
  const down = smooth([1, 1], [0, 0])[0];
  assert.ok(up > 1 - down, `attack ${up} should outpace release ${1 - down}`);
});

test("smoothing from an empty history still produces a value", () => {
  assert.strictEqual(smooth([], [0.5])[0], 0.5 * 0.55);
});

test("bass level averages only the low bands", () => {
  assert.strictEqual(bassLevel([1, 1, 1, 0, 0, 0], 3), 1);
  assert.strictEqual(bassLevel([0, 0, 0, 1, 1, 1], 3), 0);
});

test("bass level of nothing is zero", () => {
  assert.strictEqual(bassLevel([]), 0);
});
