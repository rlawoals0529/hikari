const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  blockSize,
  expand,
  explain,
  failedVolume,
  labelFor,
  pathsFor,
  readVolume,
  size,
  usageOf,
  view,
} = require("../src/lib/disk");

/**
 * Captured on this machine with `fs.statfsSync("/")`. macOS 15, APFS.
 *
 * Cross-checked against `df -k /` in the same second, which reported 971298980 1024-blocks
 * and 174513948 available. Both figures below multiply out to exactly that, which is the
 * only reason to trust that `frsize` is the right multiplier rather than to assume it.
 */
const REAL = {
  type: 26,
  bsize: 4096,
  frsize: 4096,
  blocks: 242824745,
  bfree: 43628487,
  bavail: 43628487,
  files: 1745598212,
  ffree: 1745139480,
};

const HOME = "/Users/someone";

test("a real statfs off this machine reads into the shape a widget uses", () => {
  const v = readVolume("/", REAL);
  assert.equal(v.label, "/");
  // 242824745 blocks at 4096 bytes. The same 994610155520 that `df -k` reported as
  // 971298980 1024-blocks.
  assert.equal(v.total, 994610155520);
  assert.equal(v.free, 178702282752);
  assert.equal(v.used, 994610155520 - 178702282752);
  assert.equal(Math.round(v.usage), 82);
});

test("free is the count an ordinary write can use, not the one that includes root's reserve", () => {
  // `bfree` counts blocks the filesystem holds back for root. Reading it would keep the
  // widget green while saves start failing, which is the one moment this widget exists for.
  const v = readVolume("/", { ...REAL, bfree: 43628487, bavail: 1000 });
  assert.equal(v.free, 1000 * 4096);
  assert.ok(v.usage > 99);
});

test("the block counts are multiplied by frsize, not by bsize", () => {
  // POSIX defines them in units of f_frsize. The two agree on APFS and on ext4, which is
  // exactly why using the wrong one survives every test written on the machine that wrote
  // it, and then reports a 512-byte-fragment filesystem as eight times its real size.
  const v = readVolume("/", { ...REAL, bsize: 4096, frsize: 512 });
  assert.equal(v.total, 242824745 * 512);
  assert.equal(blockSize({ bsize: 4096, frsize: 512 }), 512);
  // bsize is the fallback, for a source that reports only one of them.
  assert.equal(blockSize({ bsize: 4096 }), 4096);
  assert.equal(blockSize({}), null);
});

test("a zero total is unknown usage, not NaN percent", () => {
  // `/proc` and an empty optical drive both report zero blocks. `(0 - 0) / 0` is NaN, which
  // reaches the widget as a number and renders as "NaN%".
  assert.equal(usageOf(0, 0), null);
  assert.equal(readVolume("/proc", { ...REAL, blocks: 0, bavail: 0 }).usage, null);
  assert.equal(usageOf(100, null), null);
  assert.equal(usageOf(null, 100), null);
});

test("a full disk is a hundred percent and an empty one is nought, and both are real", () => {
  // The one place a falsy check would be a bug in the other direction: 0% used is a genuine
  // reading of a fresh volume.
  assert.equal(usageOf(1000, 0), 100);
  assert.equal(usageOf(1000, 1000), 0);
});

test("a field that coerces to zero is null, because Number(null) is 0", () => {
  // The trap `num` in weather.js was written for. A zero total is what turns a percentage
  // into NaN, so this one has to be a type check rather than a finiteness check.
  for (const v of [null, undefined, "", " ", "4096", [], {}, NaN, Infinity, -1]) {
    assert.equal(size(v), null, JSON.stringify(v));
  }
  assert.equal(size(0), 0);
  assert.equal(size(4096), 4096);
});

test("bigint sizes are accepted, because statfs returns them when asked", () => {
  // A caller passing `{ bigint: true }` must not silently read as unknown.
  assert.equal(size(4096n), 4096);
  const v = readVolume("/", { bsize: 4096n, frsize: 4096n, blocks: 100n, bavail: 40n });
  assert.equal(v.total, 409600);
  assert.equal(v.free, 163840);
});

test("used is never negative, however the container reports itself", () => {
  // On APFS a container's free space can exceed one volume's total. A negative used would
  // render as a bar drawn backwards.
  const v = readVolume("/", { ...REAL, blocks: 100, bavail: 500 });
  assert.equal(v.used, 0);
});

test("a statfs that answered nothing is an error row, not a volume of zeroes", () => {
  for (const stat of [null, undefined, "nope", 42]) {
    const v = readVolume("/", stat);
    assert.ok(v.error, JSON.stringify(stat));
    assert.equal(v.total, undefined);
  }
  // A statfs object with no sizes in it is the same: a row that says so rather than a row
  // of zeroes, which would read as an empty disk.
  const v = readVolume("/", { type: 26 });
  assert.ok(v.error);
});

test("a volume is labelled with something that fits on one row", () => {
  assert.equal(labelFor("/"), "/");
  assert.equal(labelFor("/Users/me"), "me");
  assert.equal(labelFor("/Users/me/"), "me");
  assert.equal(labelFor("/Volumes/Time Machine"), "Time Machine");
  // Both separators, so a Windows path is not labelled with the whole string.
  assert.equal(labelFor("D:\\Games"), "Games");
  assert.equal(labelFor("C:\\"), "C:");
  assert.equal(labelFor(""), null);
  assert.equal(labelFor(null), null);
});

test("the default is the home directory's filesystem", () => {
  // Not `/`. That is right on a Mac and wrong on a Windows box with the user profile on D:.
  assert.deepEqual(pathsFor({}, HOME).paths, [HOME]);
  assert.deepEqual(pathsFor(undefined, HOME).paths, [HOME]);
  assert.deepEqual(pathsFor({ paths: null }, HOME).paths, [HOME]);
});

test("a single path is accepted as well as a list", () => {
  assert.deepEqual(pathsFor({ paths: "/" }, HOME).paths, ["/"]);
  assert.deepEqual(pathsFor({ paths: ["/", "/tmp"] }, HOME).paths, ["/", "/tmp"]);
});

test("a tilde is expanded, because a shell would and JSON will not", () => {
  // Otherwise the path reaches statfs verbatim and fails with ENOENT against a directory
  // literally called `~`, naming a path the user never typed.
  assert.deepEqual(pathsFor({ paths: ["~"] }, HOME).paths, [HOME]);
  assert.deepEqual(pathsFor({ paths: ["~/Movies"] }, HOME).paths, [`${HOME}/Movies`]);
  assert.equal(expand("~", HOME), HOME);
  // Only a leading tilde that is a home reference. A directory whose name starts with a
  // tilde is a real directory.
  assert.equal(expand("/tmp/~backup", HOME), "/tmp/~backup");
  assert.equal(expand("~user/files", HOME), "~user/files");
});

test("the same filesystem written two ways is one row", () => {
  // `~` and `~/` are the same place, and two identical rows would look like a bug.
  assert.deepEqual(pathsFor({ paths: ["~", "~/"] }, HOME).paths, [HOME]);
  assert.deepEqual(pathsFor({ paths: ["/tmp", "/tmp/"] }, HOME).paths, ["/tmp"]);
});

test("a Windows drive root keeps its backslash even though the key drops it", () => {
  // `C:\` stripped to `C:` names the process's current directory on that drive rather than
  // the drive, so only the deduplication key is normalised and never the path itself.
  assert.deepEqual(pathsFor({ paths: ["C:\\"] }, HOME).paths, ["C:\\"]);
  assert.deepEqual(pathsFor({ paths: ["C:\\", "C:\\"] }, HOME).paths, ["C:\\"]);
});

test("two different paths on one container are both reported", () => {
  // On a Mac they report the same free figure, and that is correct rather than a bug.
  // Collapsing them would look like the config had been ignored.
  assert.deepEqual(pathsFor({ paths: ["/", "/System/Volumes/Data"] }, HOME).paths, [
    "/",
    "/System/Volumes/Data",
  ]);
});

test("a paths value that cannot be used is refused, not quietly replaced", () => {
  // Falling back to the default would mean editing the setting and seeing nothing change,
  // which is the same failure the weather provider refuses a missing latitude for.
  assert.match(pathsFor({ paths: 5 }, HOME).error, /not a path/);
  assert.match(pathsFor({ paths: [] }, HOME).error, /empty/);
  assert.match(pathsFor({ paths: [""] }, HOME).error, /not a path/);
  assert.match(pathsFor({ paths: ["   "] }, HOME).error, /not a path/);
  assert.match(pathsFor({ paths: ["/", null] }, HOME).error, /not a path/);
  assert.match(pathsFor({ paths: [{}] }, HOME).error, /not a path/);
  // And it names what is wrong rather than saying "invalid", so the config can be fixed
  // without guessing which entry it meant.
  assert.match(pathsFor({ paths: 5 }, HOME).error, /providers\.disk/);
});

test("an error is a sentence a person can act on, with the code still in it", () => {
  // `ENOENT` on its own is a message for somebody reading a log. The code stays in the
  // string because it is the half that can be searched for.
  assert.equal(explain({ code: "ENOENT" }), "no such path (ENOENT)");
  assert.match(explain({ code: "EACCES" }), /not allowed.*EACCES/);
  // A code with no sentence is passed through rather than replaced by "unreadable", which
  // would throw away the only information there is.
  assert.equal(explain({ code: "EWEIRD" }), "EWEIRD");
  assert.equal(explain({ message: "socket hang up" }), "socket hang up");
  assert.equal(explain(null), "unreadable");
});

test("a path that could not be measured is still a row, and still named", () => {
  // A row rather than a gap, because a mistyped path is the most likely thing to be wrong
  // about this provider and one fewer line gives you nothing to fix.
  const v = failedVolume("/Volumes/Backup", "no such path (ENOENT)");
  assert.equal(v.label, "Backup");
  assert.equal(v.error, "no such path (ENOENT)");
  assert.equal(v.total, undefined);
});

test("one unreadable path costs the others nothing", () => {
  // The same rule as one absent field in a forecast. A single availability flag over the
  // whole provider would blank three good disks for one bad path.
  const v = view([readVolume("/", REAL), failedVolume("/Volumes/Backup", "no such path (ENOENT)")]);
  assert.equal(v.available, true);
  assert.equal(v.volumes.length, 2);
  assert.equal(v.volumes[0].usage !== null, true);
  assert.ok(v.volumes[1].error);
});

test("a provider that got no answer at all is unavailable, with the reason and no volumes", () => {
  // `available` answers whether the provider got an answer, which is a different question
  // from whether any one volume could be read.
  const v = view([], "fs.statfs needs Node 18.15 or newer");
  assert.equal(v.available, false);
  assert.match(v.reason, /18\.15/);
  assert.deepEqual(v.volumes, []);
});
