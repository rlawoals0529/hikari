/**
 * The battery, from whatever the OS already knows about it.
 *
 * Nothing to install, nothing to configure and no elevated permission on any of the three
 * platforms. Two of them need a subprocess and one is a handful of files:
 *
 *   macOS    `pmset -g batt`
 *   Linux    `/sys/class/power_supply/BAT*` , read as files, no subprocess at all
 *   Windows  `WMIC PATH Win32_Battery`, with a PowerShell fallback
 *
 * This file runs the command and reads the files and does nothing else. Every parse, every
 * sentinel, and the decision that a desktop has no battery rather than an empty one, are in
 * `src/lib/battery.js`, which is what lets a Windows battery string be tested on a Mac.
 *
 * `execFile` rather than `exec`, so there is no shell and therefore no quoting to get wrong.
 * None of these commands needs one, and the argument arrays below are fixed.
 */
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { present, readPmset, readSysfs, readWmic } = require("../lib/battery");

/** Thirty seconds. A percentage moves slowly, and a subprocess twice a minute is a rounding
 *  error next to a widget that redraws every second. */
const INTERVAL_MS = 30 * 1000;

/** Enough to fail rather than hang. `pmset` and WMI both hang on a wedged power service,
 *  and a provider that never resolves stops the poller for every provider after it. */
const TIMEOUT_MS = 4000;

const SYSFS_ROOT = "/sys/class/power_supply";

/** The files `readSysfs` knows how to read. Fetched by name rather than by listing the
 *  directory, because a `power_supply` node carries dozens and this needs eight. */
const SYSFS_FILES = [
  "capacity",
  "status",
  "energy_now",
  "energy_full",
  "power_now",
  "charge_now",
  "charge_full",
  "current_now",
];

/**
 * The last good reading, kept across polls.
 *
 * A failed subprocess is a transient thing here: `pmset` can be refused a fork under load,
 * and WMI restarts itself. Keeping the reading is what makes one bad poll a dimmed number
 * rather than a blank panel, and `present()` is what stops a kept number being shown as
 * current forever.
 */
let last = null;
let lastError = null;

/** stdout, or null if the command failed. The reason is kept separately, because "there is
 *  no such command" and "the command said nothing" want different messages. */
function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve(err ? { error: err.message ?? String(err) } : { out: String(stdout) });
    });
  });
}

async function readMac(takenAt) {
  const r = await run("pmset", ["-g", "batt"]);
  if (r.error) return { error: `pmset failed: ${r.error}` };
  const reading = readPmset(r.out, takenAt);
  // Null means the output was empty, which is a `pmset` that ran and said nothing. That is
  // not a desktop: a desktop prints the "Now drawing from" line. Reported as a failure so
  // the difference stays visible rather than becoming a confident "no battery".
  return reading ? { reading } : { error: "pmset returned nothing" };
}

/**
 * Linux, with no subprocess.
 *
 * The first `BAT*` directory in sorted order. Sorted so the answer does not move between
 * polls on a machine with two packs, which a ThinkPad has; summing them is left undone
 * rather than done wrong, because two gauges do not have to report in the same units and a
 * total built from mixed units is a plausible looking lie.
 */
async function readLinux(takenAt) {
  let names;
  try {
    names = await fs.readdir(SYSFS_ROOT);
  } catch (e) {
    // No `power_supply` class at all. A container or a kernel built without it, which is
    // not the same as a machine with no battery, so it does not claim to be.
    return { error: `${SYSFS_ROOT} is not readable: ${e.code ?? e.message}` };
  }

  const bats = names.filter((n) => /^BAT/i.test(n)).sort();
  // No BAT node under a readable power_supply class is the real no-battery answer, and the
  // lib turns a null into exactly that.
  if (bats.length === 0) return { reading: readSysfs(null, takenAt) ?? { error: "unreadable" } };

  const dir = path.join(SYSFS_ROOT, bats[0]);
  const files = {};
  await Promise.all(
    SYSFS_FILES.map(async (name) => {
      try {
        files[name] = await fs.readFile(path.join(dir, name), "utf8");
      } catch {
        // A missing file is a field this machine does not report, not a failed read. Left
        // null so the lib returns null for what it feeds, rather than a zero.
        files[name] = null;
      }
    }),
  );
  return { reading: readSysfs(files, takenAt) };
}

/**
 * Windows, WMIC first and PowerShell second.
 *
 * The fallback is not belt and braces: **WMIC is deprecated and is absent from recent
 * Windows 11 builds.** Without it the provider would report "no battery" on the newest
 * laptops, which is the exact wrong answer in the exact place this widget is most wanted.
 *
 * Both paths emit `Key=Value` lines, so there is one parser rather than two. The PowerShell
 * branch formats its own output for that reason.
 */
async function readWindows(takenAt) {
  const wmic = await run("WMIC", [
    "PATH",
    "Win32_Battery",
    "GET",
    "BatteryStatus,EstimatedChargeRemaining,EstimatedRunTime",
    "/format:list",
  ]);
  if (!wmic.error) return { reading: readWmic(wmic.out, takenAt) };

  const ps = [
    "$b = Get-CimInstance Win32_Battery | Select-Object -First 1;",
    "if ($null -eq $b) { exit 0 };",
    '"BatteryStatus=$($b.BatteryStatus)";',
    '"EstimatedChargeRemaining=$($b.EstimatedChargeRemaining)";',
    '"EstimatedRunTime=$($b.EstimatedRunTime)"',
  ].join(" ");
  const shell = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  if (shell.error) return { error: `no battery source: WMIC said "${wmic.error}", PowerShell said "${shell.error}"` };
  // Empty output is the no-instance case, and `readWmic` reads it as no battery. That is
  // right here: `Get-CimInstance` succeeding with nothing to return is a positive answer.
  return { reading: readWmic(shell.out, takenAt) };
}

const READERS = { darwin: readMac, linux: readLinux, win32: readWindows };

const battery = {
  name: "battery",
  intervalMs: INTERVAL_MS,
  async read() {
    const now = Date.now();
    const reader = READERS[process.platform];
    if (!reader) {
      // Named rather than silent. A platform with no reader is a gap in this file, and a
      // dash with no reason attached is indistinguishable from a flat battery.
      return present(null, now, `no battery reader for ${process.platform}`);
    }

    let result;
    try {
      result = await reader(now);
    } catch (e) {
      result = { error: e.message ?? String(e) };
    }

    if (result.error) {
      // The kept reading survives, and the error travels with it, for the same reason the
      // weather provider keeps its last forecast: one refused fork does not make the last
      // percentage wrong.
      lastError = result.error;
      return present(last, Date.now(), lastError);
    }

    // A machine reporting no battery is cached like any other reading, and **not** latched.
    // A pack can be reseated, and a permanent "no battery" from one bad poll would need a
    // restart to clear.
    last = result.reading;
    lastError = null;
    return present(last, Date.now(), null);
  },
};

module.exports = { battery, INTERVAL_MS, TIMEOUT_MS, SYSFS_FILES, SYSFS_ROOT };
