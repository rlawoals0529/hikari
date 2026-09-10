/**
 * Reading a battery, and telling "there is no battery" apart from "the battery is empty".
 *
 * Three operating systems answer this question in three formats and none of them is JSON,
 * so all three parsers live here and the provider only runs the command. That is what lets
 * a Windows battery string be tested on a Mac, which is the only way this file was ever
 * going to be right on more than one platform.
 *
 * The rule this repo already had is **unknown is never zero**, and a battery is the place it
 * bites hardest. A desktop has no battery at all, and the number a naive read produces for
 * one is `0%`: a full-width red bar saying the machine is about to die, on a machine that
 * cannot lose power. So `installed` is a field of its own, and a read that succeeds and
 * finds no battery is a *successful* read with `percent: null`, not a failure and not a zero.
 *
 * The same rule runs the other way for the time estimate. Every one of these three sources
 * has a way of saying "I have no estimate yet" that looks like a duration: macOS prints
 * `0:00 remaining`, Linux reports a zero discharge rate, and Windows returns a sentinel of
 * 71582788 minutes. All three become null here.
 */

const { classify, present: presentReading } = require("./freshness");

/**
 * How long a battery reading stays worth showing.
 *
 * Two minutes fresh, ten minutes to expiry, against a thirty second poll. Tighter than
 * weather because a percentage moves on its own: 66% from twenty minutes ago is a number
 * nobody can act on, and a battery widget is read precisely when the answer is changing.
 */
const FRESH_MS = 2 * 60 * 1000;
const STALE_MS = 10 * 60 * 1000;

/** The windows and the wording, handed to the shared rule in `freshness.js`. */
const LIFE = {
  freshMs: FRESH_MS,
  staleMs: STALE_MS,
  missing: "no battery reading yet",
  tooOld: "the last battery reading is too old to show",
};

/**
 * @returns {"fresh" | "stale" | "expired"}
 */
function freshness(takenAt, now) {
  return classify(takenAt, now, LIFE);
}

/** Every state a battery is reported to be in, after three vocabularies are reconciled. */
const STATES = ["charging", "discharging", "charged", "not charging"];

/**
 * Whether a state means current is going in.
 *
 * `charged` is false rather than null: a full battery on mains is genuinely not charging,
 * and that is a fact rather than an absence. Only a state nobody reported is null.
 */
function chargingFrom(state) {
  if (state === null) return null;
  return state === "charging";
}

/**
 * An integer out of text, or null. Never a fallback.
 *
 * The type check is the whole point, and it is the same trap `num` in `weather.js` was
 * written for: `Number(null)` is 0, `Number("")` is 0, `Number(" ")` is 0. Every value here
 * arrives from a file or a pipe, so absence looks like an empty string rather than like
 * undefined, and a plain coercion would report a missing `capacity` file as a flat battery.
 * `parseInt` is no better: it reads "12ab" as 12 and would take a truncated read as a number.
 */
function intFrom(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * A percentage, clamped to the range a percentage has.
 *
 * Clamped rather than trusted because Linux gauges over-report after a recalibration and
 * `capacity` above 100 is common enough to have its own bug reports. A widget drawing a bar
 * from it would overflow its own panel, and that reads as a rendering fault rather than as
 * a battery quirk. Out of range in the other direction stays null instead of clamping to 0,
 * because a negative percentage is a broken read and 0% is a claim.
 */
function percentFrom(text) {
  const n = intFrom(text);
  if (n === null || n < 0) return null;
  return Math.min(100, n);
}

/**
 * `h:mm` as whole minutes, or null.
 *
 * A zero is null, deliberately, and this is the one decision in this file most likely to
 * look like a bug to the next reader. `pmset` prints `0:00 remaining` in two situations and
 * neither of them is a duration: the battery is full, or it was unplugged moments ago and
 * the estimate has not settled. "0 minutes remaining" on a machine that will run for five
 * hours is worse than saying nothing at all.
 */
function minutesFromClock(text) {
  if (typeof text !== "string") return null;
  const m = /(\d+):(\d{2})/.exec(text);
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins > 0 ? mins : null;
}

/**
 * The state words each platform uses, longest and most specific first.
 *
 * The order is load bearing and a plain `includes` in any other order is silently wrong:
 * **"discharging" contains "charging", and "not charging" contains "charging" too.** A scan
 * that tested "charging" first would report a draining battery as charging, which is the
 * single most misleading thing this widget could say.
 *
 * Scanning the line rather than splitting it on the semicolon is also deliberate. macOS puts
 * the state in a different field depending on which state it is: the charged form, the
 * discharging form and the AC-attached form do not agree on how many fields come first.
 */
const STATE_WORDS = [
  ["not charging", "not charging"],
  ["discharging", "discharging"],
  ["finishing charge", "charging"],
  ["charging", "charging"],
  ["charged", "charged"],
];

function stateFrom(line) {
  const low = line.toLowerCase();
  for (const [needle, state] of STATE_WORDS) {
    if (low.includes(needle)) return state;
  }
  return null;
}

/** A reading that says, positively, that this machine has no battery. */
function absent(takenAt) {
  return {
    takenAt: Number.isFinite(takenAt) ? takenAt : null,
    installed: false,
    percent: null,
    state: null,
    charging: null,
    // A machine with no battery is on mains by definition, and it is the one case where
    // that can be asserted rather than read.
    plugged: true,
    minutesRemaining: null,
  };
}

/**
 * `pmset -g batt` output as a reading. macOS.
 *
 * Fixture captured on this machine (macOS 15, Apple silicon):
 *
 *     Now drawing from 'Battery Power'
 *      -InternalBattery-0 (id=34734179)	66%; discharging; 5:55 remaining present: true
 *
 * A desktop Mac prints the header line and nothing after it, which is why the absence of a
 * battery line is read as "no battery" rather than as a parse failure. Those two have to
 * look different: one is a Mac mini, the other is a `pmset` that changed format.
 */
function readPmset(text, takenAt) {
  if (typeof text !== "string" || text.trim() === "") return null;

  const source = /drawing from '([^']+)'/i.exec(text)?.[1] ?? null;
  // Only the two sources that answer the question. A UPS is neither on mains nor on its own
  // battery in the sense this field means, and answering anyway would be a claim.
  const plugged = source === null ? null : /^AC Power$/i.test(source) ? true : /^Battery Power$/i.test(source) ? false : null;

  // The battery line is the one carrying a percentage. Matching on that rather than on the
  // `-InternalBattery-0` prefix, because the prefix is the internal battery's name and a
  // machine with a UPS attached lists more than one device.
  const line = text.split("\n").find((l) => /\d+%/.test(l));
  if (!line) {
    // No battery line at all. On a desktop that is the true answer, and `present: false` on
    // a line that does exist is the same answer from a laptop with the pack removed.
    return { ...absent(takenAt), plugged: plugged ?? true };
  }
  if (/present:\s*false/i.test(line)) return { ...absent(takenAt), plugged: plugged ?? true };

  const state = stateFrom(line);
  return {
    takenAt: Number.isFinite(takenAt) ? takenAt : null,
    installed: true,
    percent: percentFrom(/(\d+)%/.exec(line)?.[1] ?? null),
    state,
    charging: chargingFrom(state),
    plugged,
    // `(no estimate)` carries no clock, so the pattern simply does not match and the field
    // stays null without needing a case of its own.
    minutesRemaining: minutesFromClock(line),
  };
}

/**
 * Minutes from a rate, or null.
 *
 * One function serves both of the pairs Linux offers, because the units cancel: µWh over µW
 * and µAh over µA are both hours. **Mixing the pairs does not cancel** and would be wrong by
 * a factor of the pack voltage, roughly eleven, with no symptom other than a plausible
 * looking number. Hence one call per pair at the call site rather than a scan for whichever
 * fields happen to exist.
 *
 * A zero or missing rate is null. That is the same rule as `cpuUsage` returning null for a
 * zero delta: an idle discharge rate means the OS is not telling us the rate, and dividing
 * by it gives Infinity, which formats as "Infinity min left".
 */
function minutesFromRate(amount, rate) {
  if (amount === null || rate === null) return null;
  if (rate <= 0 || amount < 0) return null;
  return Math.round((amount / rate) * 60);
}

const SYSFS_STATES = {
  charging: "charging",
  discharging: "discharging",
  full: "charged",
  "not charging": "not charging",
  // sysfs writes "Unknown" for a gauge that has not settled. Passed through as null rather
  // than guessed at.
  unknown: null,
};

/**
 * The contents of `/sys/class/power_supply/BAT*` as a reading. Linux.
 *
 * `files` is what the provider read, one key per file, each the raw text or null for a file
 * that is not there. Not captured on this machine, which is macOS: the values below are the
 * formats the kernel's `power_supply` class documents, one integer per file with a trailing
 * newline and energies in microwatt-hours.
 *
 *     capacity     "66\n"
 *     status       "Discharging\n"
 *     energy_now   "38940000\n"
 *     power_now    "6580000\n"
 *
 * `null` for the whole object means the glob found no `BAT*` directory, which is a desktop.
 * That is a different thing from a directory whose files cannot be read, and only the first
 * one is "no battery".
 */
function readSysfs(files, takenAt) {
  if (!files || typeof files !== "object") return null;

  const raw = typeof files.status === "string" ? files.status.trim().toLowerCase() : null;
  // An unrecognised word is null, not an invented state. A kernel that adds a fifth status
  // should make the widget say it does not know rather than pick the nearest of four.
  const state = raw === null ? null : SYSFS_STATES[raw] ?? null;

  const energyNow = intFrom(files.energy_now);
  const energyFull = intFrom(files.energy_full);
  const chargeNow = intFrom(files.charge_now);
  const chargeFull = intFrom(files.charge_full);
  const power = intFrom(files.power_now);
  const current = intFrom(files.current_now);

  /**
   * How long until the thing that is happening stops happening.
   *
   * Discharging counts down what is left; charging counts down the gap to full. Neither
   * question has an answer in any other state, and answering "0 minutes" for a charged
   * battery would be the sentinel bug this file exists to avoid.
   */
  const minutes = (() => {
    if (state === "discharging") {
      return minutesFromRate(energyNow, power) ?? minutesFromRate(chargeNow, current);
    }
    if (state === "charging") {
      const byEnergy = energyFull !== null && energyNow !== null ? energyFull - energyNow : null;
      const byCharge = chargeFull !== null && chargeNow !== null ? chargeFull - chargeNow : null;
      return minutesFromRate(byEnergy, power) ?? minutesFromRate(byCharge, current);
    }
    return null;
  })();

  return {
    takenAt: Number.isFinite(takenAt) ? takenAt : null,
    installed: true,
    percent: percentFrom(files.capacity),
    state,
    charging: chargingFrom(state),
    // Derived from the status rather than from `AC*/online`. The adapter's directory is
    // named AC, ACAD, ADP0 or ADP1 depending on the machine, so reading it means globbing
    // for a name that is not knowable in advance, and every one of the four statuses
    // already implies the answer.
    plugged: state === null ? null : state !== "discharging",
    minutesRemaining: minutes,
  };
}

/**
 * `Win32_Battery.BatteryStatus`, transcribed from Microsoft's own table.
 *
 * Written out rather than computed because the numbering is not ordinal in any useful way.
 * Two of the values are documented as "Other" and "Unknown" and mean, in practice, on the
 * pack and on mains: 2 is what a plugged-in machine reports, so it says plugged without
 * claiming to know whether current is flowing.
 */
const WMI_STATES = {
  1: { state: "discharging", plugged: false },
  2: { state: null, plugged: true },
  3: { state: "charged", plugged: true },
  4: { state: "discharging", plugged: false },
  5: { state: "discharging", plugged: false },
  6: { state: "charging", plugged: true },
  7: { state: "charging", plugged: true },
  8: { state: "charging", plugged: true },
  9: { state: "charging", plugged: true },
  10: { state: null, plugged: null },
  11: { state: "not charging", plugged: true },
};

/**
 * The sentinel WMI returns for `EstimatedRunTime` when it has no estimate.
 *
 * 71582788 minutes is a hundred and thirty six years. It is not a large number that needs
 * clamping, it is a flag written in the value field, and a widget that formatted it would
 * print "2385 hours left" on a laptop sitting on mains.
 */
const WMI_UNKNOWN_RUNTIME = 71582788;

/**
 * `Key=Value` lines from `WMIC PATH Win32_Battery ... /format:list` as a reading. Windows.
 *
 * Not captured on this machine, which is macOS. The format below is what `wmic`'s list
 * output looks like, and it is also what the PowerShell fallback in the provider is written
 * to emit, so one parser covers both rather than two parsers covering one each:
 *
 *     BatteryStatus=2
 *     EstimatedChargeRemaining=94
 *     EstimatedRunTime=71582788
 *
 * A desktop has no `Win32_Battery` instance at all: `wmic` prints "No Instance(s)
 * Available." to standard error and nothing to standard output. So an output with no
 * percentage key in it is the no-battery answer, and it must not read as 0%.
 */
function readWmic(text, takenAt) {
  if (typeof text !== "string") return null;

  const fields = new Map();
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    // Lower-cased keys because `wmic` and PowerShell disagree about capitalisation on some
    // locales, and a case-sensitive lookup would read a real battery as absent.
    fields.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
  }

  const percent = percentFrom(fields.get("estimatedchargeremaining") ?? null);
  const status = intFrom(fields.get("batterystatus") ?? null);
  // No percentage and no status means no instance, which is a desktop. Requiring both to be
  // missing, because a machine that reports one and not the other has a battery and a gap,
  // and a gap is not an absence.
  if (percent === null && status === null) return absent(takenAt);

  const mapped = status === null ? { state: null, plugged: null } : WMI_STATES[status] ?? { state: null, plugged: null };
  const runtime = intFrom(fields.get("estimatedruntime") ?? null);

  return {
    takenAt: Number.isFinite(takenAt) ? takenAt : null,
    installed: true,
    percent,
    state: mapped.state,
    charging: chargingFrom(mapped.state),
    plugged: mapped.plugged,
    minutesRemaining: runtime === null || runtime === WMI_UNKNOWN_RUNTIME || runtime <= 0 ? null : runtime,
  };
}

/**
 * What to hand the widget, given the last reading and the time.
 *
 * The shared rule, so a reading that stopped arriving reads as unknown rather than as the
 * percentage it was when the polling broke.
 */
function present(reading, now, error) {
  return presentReading(reading, now, error, LIFE);
}

module.exports = {
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
};
