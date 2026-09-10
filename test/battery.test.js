const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  FRESH_MS,
  STALE_MS,
  STATES,
  WMI_UNKNOWN_RUNTIME,
  absent,
  freshness,
  intFrom,
  minutesFromClock,
  minutesFromRate,
  percentFrom,
  present,
  readPmset,
  readSysfs,
  readWmic,
  stateFrom,
} = require("../src/lib/battery");

const NOW = Date.UTC(2026, 8, 10, 19, 5);

/**
 * Captured on this machine with `pmset -g batt`. macOS 15, Apple silicon, on the pack.
 *
 * The tab between the id and the percentage is real and is what `pmset` prints, which is why
 * nothing in the parser splits on whitespace.
 */
const PMSET_REAL = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=34734179)\t66%; discharging; 5:55 remaining present: true
`;

/**
 * The other forms of the same one-line grammar.
 *
 * This machine could not be put on mains, charged or emptied during the capture, so these
 * are built from the captured line by changing the fields `pmset` varies rather than
 * captured whole. The grammar is the captured one: source in quotes on the header, then
 * percent, state and time separated by semicolons, then `present:`.
 */
const PMSET_CHARGING = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=34734179)\t41%; charging; 1:14 remaining present: true
`;
const PMSET_CHARGED = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=34734179)\t100%; charged; 0:00 remaining present: true
`;
const PMSET_NOT_CHARGING = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=34734179)\t79%; not charging; 0:00 remaining present: true
`;
const PMSET_NO_ESTIMATE = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=34734179)\t66%; discharging; (no estimate) present: true
`;
/** A desktop Mac. The header line and nothing after it, which is the whole fixture. */
const PMSET_DESKTOP = `Now drawing from 'AC Power'
`;
const PMSET_PACK_REMOVED = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=34734179)\t0%; discharging; 0:00 remaining present: false
`;

/**
 * `/sys/class/power_supply/BAT0` as the provider reads it, one key per file.
 *
 * Not captured on this machine, which is macOS. These are the formats the kernel's
 * `power_supply` class documents: one integer per file with a trailing newline, energies in
 * microwatt-hours and rates in microwatts.
 */
const SYSFS_DISCHARGING = {
  capacity: "66\n",
  status: "Discharging\n",
  energy_now: "38940000\n",
  energy_full: "59000000\n",
  power_now: "6580000\n",
  charge_now: null,
  charge_full: null,
  current_now: null,
};

/**
 * `WMIC PATH Win32_Battery ... /format:list` output, and the shape the PowerShell fallback
 * is written to emit so that one parser covers both. Not captured on this machine.
 */
const WMIC_ON_MAINS = "\r\nBatteryStatus=2\r\nEstimatedChargeRemaining=94\r\nEstimatedRunTime=71582788\r\n\r\n";

test("the real pmset output off this machine reads into the shape a widget uses", () => {
  const r = readPmset(PMSET_REAL, NOW);
  assert.equal(r.installed, true);
  assert.equal(r.percent, 66);
  assert.equal(r.state, "discharging");
  assert.equal(r.charging, false);
  assert.equal(r.plugged, false);
  assert.equal(r.minutesRemaining, 5 * 60 + 55);
  assert.equal(r.takenAt, NOW);
});

test("a desktop reports no battery, not nought percent", () => {
  // The whole reason this provider has an `installed` field. 0% is a full red bar saying the
  // machine is about to die, on a machine that cannot lose power, and it is the number a
  // naive read produces for a Mac mini.
  const r = readPmset(PMSET_DESKTOP, NOW);
  assert.equal(r.installed, false);
  assert.equal(r.percent, null);
  assert.equal(r.state, null);
  assert.equal(r.charging, null);
  // A machine with no battery is on mains by definition. The one thing that can be asserted
  // rather than read.
  assert.equal(r.plugged, true);
  assert.equal(r.minutesRemaining, null);
});

test("a laptop with the pack out is the same answer as a desktop, and not a flat battery", () => {
  // `present: false` on a line that carries `0%`. Reading the percentage and ignoring the
  // flag is the same bug wearing a laptop's clothes.
  const r = readPmset(PMSET_PACK_REMOVED, NOW);
  assert.equal(r.installed, false);
  assert.equal(r.percent, null);
});

test("a state word is never confused with the word inside it", () => {
  // "discharging" contains "charging", and "not charging" contains it too. A scan in any
  // other order reports a draining battery as charging, which is the most misleading thing
  // this widget could say.
  assert.equal(stateFrom("66%; discharging; 5:55 remaining"), "discharging");
  assert.equal(stateFrom("79%; not charging; 0:00 remaining"), "not charging");
  assert.equal(stateFrom("41%; charging; 1:14 remaining"), "charging");
  assert.equal(stateFrom("100%; charged; 0:00 remaining"), "charged");
  assert.equal(stateFrom("98%; finishing charge; 0:12 remaining"), "charging");
});

test("every state the parsers can produce is one this repo has a word for", () => {
  const produced = [PMSET_REAL, PMSET_CHARGING, PMSET_CHARGED, PMSET_NOT_CHARGING].map(
    (t) => readPmset(t, NOW).state,
  );
  for (const s of produced) assert.ok(STATES.includes(s), `${s} is not a known state`);
});

test("charging is derived from the state, and charged is not charging", () => {
  // A full battery on mains is genuinely not charging. That is a fact, so it is false rather
  // than unknown, and only a state nobody reported is null.
  assert.equal(readPmset(PMSET_CHARGING, NOW).charging, true);
  assert.equal(readPmset(PMSET_CHARGED, NOW).charging, false);
  assert.equal(readPmset(PMSET_CHARGED, NOW).state, "charged");
  assert.equal(readPmset(PMSET_NOT_CHARGING, NOW).charging, false);
});

test("the mains state comes from the header, and an unknown source stays unknown", () => {
  assert.equal(readPmset(PMSET_CHARGING, NOW).plugged, true);
  assert.equal(readPmset(PMSET_REAL, NOW).plugged, false);
  const ups = readPmset("Now drawing from 'UPS Power'\n -InternalBattery-0 (id=1)\t66%; discharging; 5:55 remaining present: true", NOW);
  // A UPS is neither on mains nor on its own pack in the sense this field means, and
  // answering anyway would be a claim.
  assert.equal(ups.plugged, null);
});

test("0:00 remaining is no estimate, not zero minutes left", () => {
  // pmset prints 0:00 for a charged battery and for one unplugged moments ago. "0 minutes
  // remaining" on a machine that will run for five hours is worse than saying nothing.
  assert.equal(readPmset(PMSET_CHARGED, NOW).minutesRemaining, null);
  assert.equal(readPmset(PMSET_NOT_CHARGING, NOW).minutesRemaining, null);
  assert.equal(minutesFromClock("0:00 remaining"), null);
  assert.equal(minutesFromClock("0:01 remaining"), 1);
});

test("(no estimate) leaves the time unknown rather than throwing", () => {
  const r = readPmset(PMSET_NO_ESTIMATE, NOW);
  assert.equal(r.percent, 66);
  assert.equal(r.minutesRemaining, null);
});

test("a percentage over a hundred is clamped, and under zero is unknown", () => {
  // Linux gauges over-report after a recalibration. A bar drawn from 104 overflows its own
  // panel and reads as a rendering fault. A negative is a broken read, and 0% is a claim.
  assert.equal(percentFrom("104"), 100);
  assert.equal(percentFrom("100"), 100);
  assert.equal(percentFrom("0"), 0);
  assert.equal(percentFrom("-3"), null);
});

test("a value that coerces to zero is null, because Number(null) is 0", () => {
  // The trap `num` in weather.js was written for, and worse here: every value arrives from a
  // file or a pipe, so absence looks like an empty string. A missing capacity file read as a
  // flat battery would be this repo's one rule broken in the place it matters most.
  for (const v of [null, undefined, "", " ", "\n", [], {}, "12ab", "1.5", true]) {
    assert.equal(intFrom(v), null, JSON.stringify(v));
    assert.equal(percentFrom(v), null, JSON.stringify(v));
  }
  assert.equal(intFrom("0"), 0);
  assert.equal(intFrom("66\n"), 66);
});

test("a zero percent that really is zero survives", () => {
  // The one place a falsy check would be a real bug in the other direction: a battery at 0
  // that is installed and discharging is a genuine reading.
  const r = readSysfs({ ...SYSFS_DISCHARGING, capacity: "0\n" }, NOW);
  assert.equal(r.percent, 0);
  assert.equal(r.installed, true);
});

test("sysfs counts down what is left while discharging", () => {
  const r = readSysfs(SYSFS_DISCHARGING, NOW);
  assert.equal(r.percent, 66);
  assert.equal(r.state, "discharging");
  assert.equal(r.charging, false);
  assert.equal(r.plugged, false);
  // 38940000 microwatt-hours at 6580000 microwatts is 5.918 hours, so 355 minutes.
  assert.equal(r.minutesRemaining, 355);
});

test("sysfs counts down the gap to full while charging, not what is in the pack", () => {
  // The distinction that makes this two branches rather than one. Reporting energy over
  // power while charging would say five hours left on a battery eight minutes from full.
  const r = readSysfs({ ...SYSFS_DISCHARGING, status: "Charging\n" }, NOW);
  assert.equal(r.state, "charging");
  assert.equal(r.charging, true);
  assert.equal(r.plugged, true);
  // (59000000 - 38940000) / 6580000 hours is 3.049, so 183 minutes.
  assert.equal(r.minutesRemaining, 183);
});

test("a zero discharge rate is unknown, not Infinity", () => {
  // Dividing by it gives Infinity, which reaches a widget as a number and renders as
  // "Infinity min left". Same rule as the cpu provider returning null for a zero delta.
  assert.equal(readSysfs({ ...SYSFS_DISCHARGING, power_now: "0\n" }, NOW).minutesRemaining, null);
  assert.equal(minutesFromRate(38940000, 0), null);
  assert.equal(minutesFromRate(38940000, null), null);
  assert.equal(minutesFromRate(null, 6580000), null);
});

test("the charge and current pair is used when the energy pair is absent", () => {
  // Some gauges report microamp-hours and microamps instead. The units cancel the same way,
  // which is why one function serves both.
  const r = readSysfs(
    { capacity: "50\n", status: "Discharging\n", charge_now: "3000000\n", current_now: "1500000\n" },
    NOW,
  );
  assert.equal(r.minutesRemaining, 120);
});

test("the two pairs are never mixed, because the units would not cancel", () => {
  // Energy over current is wrong by a factor of the pack voltage, roughly eleven, and the
  // only symptom is a plausible looking number. Unknown is the right answer here.
  const r = readSysfs(
    { capacity: "66\n", status: "Discharging\n", energy_now: "38940000\n", current_now: "1500000\n" },
    NOW,
  );
  assert.equal(r.minutesRemaining, null);
});

test("sysfs Full is charged, and Unknown is no state rather than a guess", () => {
  assert.equal(readSysfs({ ...SYSFS_DISCHARGING, status: "Full\n" }, NOW).state, "charged");
  assert.equal(readSysfs({ ...SYSFS_DISCHARGING, status: "Unknown\n" }, NOW).state, null);
  assert.equal(readSysfs({ ...SYSFS_DISCHARGING, status: "Unknown\n" }, NOW).plugged, null);
  // A kernel that adds a fifth status should make the widget say it does not know rather
  // than pick the nearest of four.
  assert.equal(readSysfs({ ...SYSFS_DISCHARGING, status: "Recalibrating\n" }, NOW).state, null);
});

test("a missing status file costs the percentage nothing", () => {
  // One absent field must not blank the row, which is what a single availability flag would
  // do. Same rule as a forecast missing its daily high.
  const r = readSysfs({ capacity: "66\n", status: null }, NOW);
  assert.equal(r.percent, 66);
  assert.equal(r.state, null);
  assert.equal(r.minutesRemaining, null);
});

test("no BAT directory at all is no battery, not an unreadable one", () => {
  assert.equal(readSysfs(null, NOW), null);
  const r = readSysfs({}, NOW);
  // An empty object is a BAT node whose files could not be read: a battery, with gaps.
  assert.equal(r.installed, true);
  assert.equal(r.percent, null);
});

test("the WMI run-time sentinel is unknown, not a hundred and thirty six years", () => {
  // 71582788 minutes is a flag written in a value field. A widget that formatted it would
  // print "2385 hours left" on a laptop sitting on mains.
  const r = readWmic(WMIC_ON_MAINS, NOW);
  assert.equal(r.percent, 94);
  assert.equal(r.minutesRemaining, null);
  assert.equal(WMI_UNKNOWN_RUNTIME, 71582788);
});

test("BatteryStatus 2 says on mains without claiming to know about current", () => {
  const r = readWmic(WMIC_ON_MAINS, NOW);
  assert.equal(r.plugged, true);
  assert.equal(r.state, null);
  assert.equal(r.charging, null);
});

test("every documented BatteryStatus maps to a state this repo has a word for", () => {
  // Transcribed from Microsoft's table. A value with no mapping would read as unknown for a
  // real state, which is the same failure a missing WMO weather code would be.
  for (let status = 1; status <= 11; status++) {
    const r = readWmic(`BatteryStatus=${status}\nEstimatedChargeRemaining=50\n`, NOW);
    assert.equal(r.installed, true, `status ${status}`);
    assert.ok(r.state === null || STATES.includes(r.state), `status ${status} gave ${r.state}`);
  }
  assert.equal(readWmic("BatteryStatus=6\nEstimatedChargeRemaining=50\n", NOW).charging, true);
  assert.equal(readWmic("BatteryStatus=1\nEstimatedChargeRemaining=50\n", NOW).plugged, false);
  assert.equal(readWmic("BatteryStatus=3\nEstimatedChargeRemaining=100\n", NOW).state, "charged");
});

test("no Win32_Battery instance is no battery, and not nought percent", () => {
  // A desktop. `wmic` prints "No Instance(s) Available." to standard error and nothing to
  // standard output, so an output with neither key in it is the no-battery answer.
  for (const text of ["", "\r\n\r\n", "No Instance(s) Available."]) {
    const r = readWmic(text, NOW);
    assert.equal(r.installed, false, JSON.stringify(text));
    assert.equal(r.percent, null, JSON.stringify(text));
  }
});

test("a battery reporting one key and not the other is a gap, not an absence", () => {
  const r = readWmic("EstimatedChargeRemaining=50\n", NOW);
  assert.equal(r.installed, true);
  assert.equal(r.percent, 50);
  assert.equal(r.state, null);
});

test("WMI keys are matched without regard to case", () => {
  // `wmic` and PowerShell disagree about capitalisation on some locales, and a
  // case-sensitive lookup would read a real battery as absent.
  const r = readWmic("batterystatus=6\nESTIMATEDCHARGEREMAINING=44\nEstimatedRunTime=90\n", NOW);
  assert.equal(r.percent, 44);
  assert.equal(r.state, "charging");
  assert.equal(r.minutesRemaining, 90);
});

test("garbage in reads as nulls rather than throwing", () => {
  for (const v of [null, undefined, 42, {}, []]) {
    assert.equal(readPmset(v, NOW), null, JSON.stringify(v));
    assert.equal(readWmic(v, NOW), null, JSON.stringify(v));
  }
  assert.equal(readPmset("   ", NOW), null);
});

test("a reading is fresh, then stale, then expired", () => {
  assert.equal(freshness(NOW, NOW), "fresh");
  assert.equal(freshness(NOW - FRESH_MS, NOW), "fresh");
  assert.equal(freshness(NOW - FRESH_MS - 1, NOW), "stale");
  assert.equal(freshness(NOW - STALE_MS - 1, NOW), "expired");
});

test("the freshness windows are what they are", () => {
  // Written out longhand. The risk is these drifting upward until a half-hour-old percentage
  // counts as current, and a test that read the constant would drift with it.
  assert.equal(FRESH_MS, 2 * 60 * 1000);
  assert.equal(STALE_MS, 10 * 60 * 1000);
});

test("an expired reading shows no percentage, with the reason", () => {
  // The promise the README makes: a reading that stopped arriving says it does not know,
  // rather than showing twenty minutes ago as though it were now.
  const p = present(readPmset(PMSET_REAL, NOW - STALE_MS - 1000), NOW);
  assert.equal(p.available, false);
  assert.equal(p.percent, undefined);
  assert.match(p.reason, /too old/);
});

test("a stale reading is still shown, and says it is stale", () => {
  const p = present(readPmset(PMSET_REAL, NOW - FRESH_MS - 1000), NOW);
  assert.equal(p.available, true);
  assert.equal(p.freshness, "stale");
  assert.equal(p.percent, 66);
});

test("no reading at all is unavailable with a reason, never zero", () => {
  const p = present(null, NOW);
  assert.equal(p.available, false);
  assert.equal(p.percent, undefined);
  assert.ok(p.reason);
});

test("an error beside a fresh reading keeps the reading and mentions the error", () => {
  const p = present(readPmset(PMSET_REAL, NOW), NOW, "pmset failed: EAGAIN");
  assert.equal(p.available, true);
  assert.equal(p.percent, 66);
  assert.match(p.reason, /EAGAIN/);
});

test("a no-battery reading survives being presented, and stays not-a-zero", () => {
  // The state most likely to be flattened by a later refactor: it is `available: true` with
  // no percentage, which is a shape nothing else in this repo has.
  const p = present(absent(NOW), NOW);
  assert.equal(p.available, true);
  assert.equal(p.installed, false);
  assert.equal(p.percent, null);
});
