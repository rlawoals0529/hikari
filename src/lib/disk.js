/**
 * Free space, from the one call that does not need a subprocess.
 *
 * `fs.statfs` landed in Node 18.15 and answers this on Windows, macOS and Linux with the
 * same shape, which is why there is no parser in here for `df` or for `WMIC LOGICALDISK`.
 * The provider checks the function exists before relying on it and says so if it does not,
 * because "your Node is too old" and "that path is not there" need different messages.
 *
 * Everything that is a decision is here: which paths to look at, which of the two free-block
 * counts to believe, what to call a volume, and what a percentage is when the total is zero.
 * The provider does the syscall and nothing else.
 *
 * **No staleness rule, and that is deliberate.** Weather and the calendar keep their last
 * reading because a network can drop and come back. A `statfs` failure is not an outage: it
 * is a permanent fact about a path, usually that it is spelled wrong or that the drive was
 * unplugged, and riding it out on a cached figure would hide the one thing you need to see.
 * So a bad path reports its own error, on its own row, on every poll.
 */

const os = require("node:os");

/**
 * A size out of a `statfs` field, or null. Never a fallback.
 *
 * Both number and bigint are accepted because `statfs` returns bigints when asked for them,
 * and a future caller passing `{ bigint: true }` must not silently read as unknown. Nothing
 * else is: the same trap as `num` in `weather.js`, and worse here, because `Number(null)` is
 * 0 and a zero total is what turns a free-space percentage into `NaN%`.
 */
function size(v) {
  if (typeof v === "bigint") return Number(v);
  if (typeof v !== "number") return null;
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * The multiplier for the block counts.
 *
 * POSIX defines `f_blocks`, `f_bfree` and `f_bavail` in units of **`f_frsize`**, not
 * `f_bsize`. The two are both 4096 on APFS and on ext4, which is exactly why using the
 * wrong one is a bug that survives every test written on the machine that wrote it, and
 * then reports a filesystem with a 512-byte fragment size as eight times its real capacity.
 */
function blockSize(stat) {
  return size(stat?.frsize) ?? size(stat?.bsize);
}

/**
 * A path as the short name a widget can fit on one row.
 *
 * The trailing segment, because that is what identifies a volume to the person reading it:
 * `/Users/me` is too wide for a 230 pixel panel and `me` is not ambiguous next to `/`.
 * Both separators are split on, so a Windows `D:\Games` labels as `Games` rather than as
 * the whole string, and a root path keeps its own name rather than labelling as nothing.
 */
function labelFor(path) {
  if (typeof path !== "string" || path.trim() === "") return null;
  const trimmed = path.trim();
  const stripped = trimmed.replace(/[/\\]+$/, "");
  if (stripped === "") return trimmed.slice(0, 1);
  const last = stripped.split(/[/\\]/).pop();
  return last === "" ? stripped : last;
}

/**
 * A tilde, expanded.
 *
 * A shell expands `~` and JSON does not, so a config written the way a person writes a path
 * would reach `statfs` verbatim and fail with ENOENT against a directory literally called
 * `~`. The error message would name a path the user never typed, which points nowhere.
 */
function expand(path, home) {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return `${home}${path.slice(1)}`;
  return path;
}

/**
 * Which paths to report on.
 *
 * The home directory by default, because it is the filesystem that fills up and the only
 * one that is on every platform under a name this code can work out. `/` would be right on
 * a Mac and wrong on a Windows box with the user profile on D:.
 *
 * A `paths` value that is present but unusable is **refused rather than ignored**. Falling
 * back to the default would mean editing the setting and seeing nothing change, which is
 * the same failure the weather provider refuses a missing latitude for.
 *
 * @returns {{paths: string[]} | {error: string}}
 */
function pathsFor(config, home) {
  const fallback = typeof home === "string" && home !== "" ? home : os.homedir();
  const raw = config?.paths;
  if (raw === undefined || raw === null) return { paths: [fallback] };

  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) {
    return { error: '"paths" under providers.disk is empty, so there is nothing to measure' };
  }
  const bad = list.find((p) => typeof p !== "string" || p.trim() === "");
  if (bad !== undefined) {
    return { error: `"paths" under providers.disk contains ${JSON.stringify(bad)}, which is not a path` };
  }

  // Duplicates collapse, and only duplicates. Two *different* paths on one APFS container
  // legitimately report the same free figure, and hiding the second would look like the
  // config had been ignored.
  //
  // The key is compared with trailing separators off, because `~` and `~/` are the same
  // filesystem written two ways and would otherwise be two identical rows. Only the key is
  // normalised: the path handed to `statfs` keeps whatever the user wrote, because a
  // Windows drive root is `C:\` and stripping that backslash leaves `C:`, which names the
  // process's current directory on that drive rather than the drive.
  const seen = new Set();
  const paths = [];
  for (const p of list) {
    const full = expand(p.trim(), fallback);
    const key = full.replace(/(.)[/\\]+$/, "$1");
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(full);
  }
  return { paths };
}

/**
 * Percent used, or null.
 *
 * Null for a zero total, which is not a rounding worry but the real shape of a pseudo
 * filesystem: `/proc` and a Windows empty optical drive both report zero blocks, and
 * `(0 - 0) / 0` is NaN, which reaches the widget as a number and renders as `NaN%`.
 */
function usageOf(total, free) {
  if (total === null || free === null || total <= 0) return null;
  return ((total - free) / total) * 100;
}

/**
 * One volume, from the path asked about and the `statfs` result for it.
 *
 * `free` is `bavail`, not `bfree`, and the difference is the point. `bfree` counts the
 * blocks the filesystem holds back for root, so a disk with nothing writable left still
 * reports a few gigabytes free and the widget stays green while saves start failing.
 * `bavail` is the number a person can act on.
 *
 * On macOS every volume in an APFS container reports the container's free space, so two
 * paths on one Mac give the same free figure. That is correct rather than a bug, and it is
 * why `used` is derived as total minus free here instead of being read from anywhere: the
 * per-volume "used" a Mac reports is about the volume, and the free space is about the
 * container, and subtracting one from the other mixes two different questions.
 * Cross-checked against `df -k` on this machine.
 *
 * @returns {{path, label, total, free, used, usage} | {path, label, error}}
 */
function readVolume(path, stat) {
  const label = labelFor(path);
  if (!stat || typeof stat !== "object") {
    return { path, label, error: "no answer from the filesystem" };
  }
  const unit = blockSize(stat);
  const blocks = size(stat.blocks);
  const avail = size(stat.bavail);
  if (unit === null || unit <= 0 || blocks === null || avail === null) {
    return { path, label, error: "the filesystem reported no sizes" };
  }
  const total = blocks * unit;
  const free = avail * unit;
  return {
    path,
    label,
    total,
    free,
    // Never negative. A container whose free space exceeds one volume's total is normal on
    // APFS, and a negative "used" would render as a bar drawn backwards.
    used: Math.max(0, total - free),
    usage: usageOf(total, free),
  };
}

/**
 * The errno codes worth a sentence, and what to say instead.
 *
 * A widget shows this text verbatim, and `ENOENT` on its own is a message for somebody
 * reading a log. The code is kept in the string as well as the sentence, because it is the
 * half that can be searched for when the sentence turns out not to be the whole story.
 */
const REASONS = {
  ENOENT: "no such path",
  EACCES: "not allowed to read that path",
  EPERM: "not allowed to read that path",
  ENOTDIR: "a file, not a filesystem",
  EIO: "the drive returned an I/O error",
};

/** An error from `statfs` as something a person can act on. */
function explain(err) {
  const code = typeof err?.code === "string" ? err.code : null;
  if (code === null) return typeof err?.message === "string" ? err.message : "unreadable";
  const said = REASONS[code];
  return said ? `${said} (${code})` : code;
}

/**
 * A row for a path that could not be measured at all.
 *
 * A row rather than a dropped entry, because a path in the config that is not there is the
 * single most likely thing to be wrong about this provider, and a widget that simply showed
 * one fewer line would give you nothing to fix. One bad path costs the others nothing, the
 * same way one absent field in a forecast costs the others nothing.
 */
function failedVolume(path, reason) {
  return { path, label: labelFor(path), error: reason };
}

/**
 * What to hand the widget.
 *
 * `available` answers "did the provider get an answer at all", which is a different question
 * from whether any individual volume could be read. Collapsing the two would let one
 * mistyped path blank a widget that is correctly reporting three other disks.
 */
function view(volumes, error) {
  if (error) return { available: false, reason: error, volumes: [] };
  return { available: true, volumes };
}

module.exports = {
  REASONS,
  blockSize,
  explain,
  expand,
  failedVolume,
  labelFor,
  pathsFor,
  readVolume,
  size,
  usageOf,
  view,
};
