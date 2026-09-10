const { test } = require("node:test");
const assert = require("node:assert");
const { moodFrom, breath, blinking, isLate } = require("../src/lib/mood.js");

const at = (usage, hour = 14, extra = {}) => moodFrom({ cpu: { usage }, ...extra }, hour);

test("a machine that cannot be measured says so", () => {
  // cpuUsage() returns null when two samples land in one tick. Drawing that as a settled,
  // idle companion is the failure: it looks like a reading and it is the absence of one.
  for (const nothing of [null, undefined, NaN]) {
    assert.strictEqual(moodFrom({ cpu: { usage: nothing } }, 14).name, "unknown");
  }
  assert.strictEqual(moodFrom({}, 14).name, "unknown");
  assert.strictEqual(moodFrom(undefined, 14).name, "unknown");
});

test("unknown does not look like calm", () => {
  // Whatever else changes, these two must never render the same.
  const idle = at(5);
  const unknown = moodFrom({}, 14);
  assert.notStrictEqual(unknown.eyes, idle.eyes);
  assert.notStrictEqual(unknown.label, idle.label);
});

test("load picks the mood", () => {
  assert.strictEqual(at(5).name, "idle");
  assert.strictEqual(at(45).name, "working");
  assert.strictEqual(at(85).name, "busy");
});

test("the thresholds are inclusive at the boundary", () => {
  assert.strictEqual(at(29.9).name, "idle");
  assert.strictEqual(at(30).name, "working");
  assert.strictEqual(at(69.9).name, "working");
  assert.strictEqual(at(70).name, "busy");
});

test("music beats the clock, but strain beats music", () => {
  const playing = { media: { isPlaying: true } };
  // 2am with something playing is listening, not asleep.
  assert.strictEqual(at(10, 2, playing).name, "listening");
  // But a machine at 90% is straining whatever is on the speakers.
  assert.strictEqual(at(90, 2, playing).name, "busy");
});

test("late and quiet is asleep", () => {
  assert.strictEqual(at(5, 23).name, "sleepy");
  assert.strictEqual(at(5, 3).name, "sleepy");
  assert.strictEqual(at(5, 22).name, "idle");
  assert.strictEqual(at(5, 5).name, "idle");
});

test("being asleep does not hide a working machine", () => {
  // Two rules could both apply at 3am under load. Strain is the one worth showing.
  assert.strictEqual(at(85, 3).name, "busy");
});

test("isLate wraps around midnight and ignores nonsense", () => {
  assert.ok(isLate(23) && isLate(0) && isLate(4));
  assert.ok(!isLate(6) && !isLate(12) && !isLate(22));
  assert.ok(!isLate(undefined) && !isLate("3") && !isLate(2.5));
});

test("every mood carries an energy, eyes and a label", () => {
  const seen = new Set();
  for (const [usage, hour, extra] of [
    [null, 14, {}], [85, 14, {}], [10, 14, { media: { isPlaying: true } }],
    [5, 2, {}], [45, 14, {}], [5, 14, {}],
  ]) {
    const m = moodFrom({ cpu: { usage }, ...extra }, hour);
    seen.add(m.name);
    assert.ok(m.energy >= 0 && m.energy <= 1, `${m.name} energy out of range`);
    assert.ok(m.eyes && m.label, `${m.name} is missing eyes or a label`);
  }
  assert.strictEqual(seen.size, 6, "each of the six moods is reachable");
});

test("breath returns to where it started and never leaves 0..1", () => {
  for (const energy of [0, 0.5, 1]) {
    const period = 4000 - energy * 3100;
    assert.ok(Math.abs(breath(0, energy) - breath(period, energy)) < 1e-9, "the cycle closes");
    for (let t = 0; t < period; t += period / 37) {
      const v = breath(t, energy);
      assert.ok(v >= 0 && v <= 1, `breath ${v} left the range`);
    }
  }
});

test("more energy means a faster breath", () => {
  // Half a slow period is a full swing; the same instant at high energy has already
  // been round more than once.
  assert.ok(breath(2000, 0) > 0.9, "a calm breath peaks at two seconds");
  assert.notStrictEqual(breath(2000, 0), breath(2000, 1));
});

test("breath tolerates rubbish rather than returning NaN", () => {
  // One NaN reaching a transform silently freezes the whole character.
  for (const bad of [undefined, null, NaN, "x"]) {
    assert.ok(Number.isFinite(breath(bad, 0.5)), `breath(${bad}) was not finite`);
    assert.ok(Number.isFinite(breath(1000, bad)), `energy ${bad} was not finite`);
  }
});

test("closed eyes stay closed and a question mark never blinks", () => {
  for (let t = 0; t < 12000; t += 97) {
    assert.strictEqual(blinking(t, "closed"), true);
    assert.strictEqual(blinking(t, "question"), false);
  }
});

test("open eyes blink, but rarely", () => {
  let shut = 0, frames = 0;
  for (let t = 0; t < 60000; t += 16) { frames++; if (blinking(t, "open")) shut++; }
  const share = shut / frames;
  assert.ok(share > 0, "it blinks at all");
  assert.ok(share < 0.08, `blinking ${(share * 100).toFixed(1)}% of the time is a twitch`);
});

test("blinking is a function of time, so a screenshot is reproducible", () => {
  assert.strictEqual(blinking(5000, "open"), blinking(5000, "open"));
});
